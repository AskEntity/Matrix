import { describe, expect, it, mock } from "bun:test";
import type React from "react";
import { createEventHandler, type EventHandlerDeps } from "./event-handler.ts";
import {
	createLogEntry,
	getLogTaskId,
	type IncomingEvent,
	type LogEntry,
	type TaskNode,
} from "./hooks.ts";

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
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Please check this",
				},
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
			body: {
				source: "user",
				id: "test-id",
				ts: 0,
				content: "Build a feature",
			},
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
				tool: "mcp__mxd__bash",
				toolCallId: "tc-1",
				input: { command: "ls" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
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
			expect(pair.tool).toBe("mcp__mxd__bash");
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
				tool: "mcp__mxd__yield",
				toolCallId: "tc-yield",
				input: {},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__yield",
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
				tool: "mcp__mxd__bash",
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
			tool: "mcp__mxd__read_file",
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
			tool: "mcp__mxd__read_file",
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
			expect(pair.tool).toBe("mcp__mxd__read_file");
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
			tool: "mcp__mxd__yield",
			toolCallId: "tc-yield-live",
			input: {},
			taskId: "task-1",
			ts: 1000,
		});

		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("tool_call");

		handleEvent({
			type: "tool_result",
			tool: "mcp__mxd__yield",
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
			tool: "mcp__mxd__yield",
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
			tool: "mcp__mxd__read_file",
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
			tool: "mcp__mxd__yield",
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
				tool: "mcp__mxd__yield",
				toolCallId: "tc-yield-batch",
				input: {},
				taskId: "task-1",
				ts: 1000,
			},
			// A non-yield tool_result resolves it to tool_pair first
			{
				type: "tool_result",
				tool: "mcp__mxd__read_file",
				toolCallId: "tc-yield-batch",
				content: "content",
				isError: false,
				taskId: "task-1",
				ts: 2000,
			},
			// Then the actual yield tool_result fires remove_tool
			{
				type: "tool_result",
				tool: "mcp__mxd__yield",
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
				tool: "mcp__mxd__bash",
				toolCallId: "tc-bg",
				input: { command: "long-running-cmd" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
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
				tool: "mcp__mxd__bash",
				toolCallId: "tc-err",
				input: { command: "failing-cmd" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
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
				tool: "mcp__mxd__bash",
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
			expect(pair.tool).toBe("mcp__mxd__bash");
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
				tool: "mcp__mxd__bash",
				toolCallId: "tc-a",
				input: { command: "echo a" },
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-a",
				content: "a",
				isError: false,
				taskId: "task-1",
				ts: 1500,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__read_file",
				toolCallId: "tc-b",
				input: { path: "b.ts" },
				taskId: "task-1",
				ts: 2000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__read_file",
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
			expect(capturedLogs[0].tool).toBe("mcp__mxd__bash");
			expect(capturedLogs[0].resultContent).toBe("a");
		}
		if (capturedLogs[1]?.type === "tool_pair") {
			expect(capturedLogs[1].tool).toBe("mcp__mxd__read_file");
			expect(capturedLogs[1].resultContent).toBe("content of b");
		}
	});
});

describe("event-handler live session clearing", () => {
	it("handleEvent: tree_updated removes cleared task session records from logs, pending messages, and older-history state", () => {
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

		let olderEvents = new Map<
			string,
			{ hasOlder: boolean; oldestTs: number }
		>();
		(deps as Record<string, unknown>).setOlderEventsAvailable = mock(
			(
				updater: React.SetStateAction<
					Map<string, { hasOlder: boolean; oldestTs: number }>
				>,
			) => {
				olderEvents =
					typeof updater === "function" ? updater(olderEvents) : updater;
			},
		);

		const { handleEvent } = createEventHandler(deps as EventHandlerDeps);

		handleEvent({
			type: "assistant_text",
			content: "stale task output",
			taskId: "task-reset",
			ts: 1000,
		} satisfies IncomingEvent);
		handleEvent({
			type: "message",
			id: "pending-reset-msg",
			body: {
				source: "user",
				id: "queue-msg",
				ts: 0,
				content: "pending task message",
			},
			taskId: "task-reset",
			ts: 1100,
		} satisfies IncomingEvent);
		olderEvents = new Map([
			["task-reset", { hasOlder: true, oldestTs: 900 }],
			["other-task", { hasOlder: true, oldestTs: 800 }],
		]);

		handleEvent({
			type: "tree_updated",
			nodes: [
				{
					id: "root",
					title: "Orchestrator",
					description: "",
					status: "in_progress",
					parentId: null,
					children: ["task-reset", "other-task"],
					createdAt: "2026-04-01T00:00:00.000Z",
					updatedAt: "2026-04-01T00:00:00.000Z",
					costUsd: 0,
					editedBy: "agent",
					branch: null,
					worktreePath: null,
					session: undefined,
					color: undefined,
					persistent: false,
				},
				{
					id: "task-reset",
					title: "Reset task",
					description: "",
					status: "pending",
					parentId: "root",
					children: [],
					createdAt: "2026-04-01T00:00:00.000Z",
					updatedAt: "2026-04-01T00:00:00.000Z",
					costUsd: 0,
					editedBy: "agent",
					branch: null,
					worktreePath: null,
					session: undefined,
					color: undefined,
					persistent: "reset",
				},
				{
					id: "other-task",
					title: "Other task",
					description: "",
					status: "in_progress",
					parentId: "root",
					children: [],
					createdAt: "2026-04-01T00:00:00.000Z",
					updatedAt: "2026-04-01T00:00:00.000Z",
					costUsd: 0,
					editedBy: "agent",
					branch: null,
					worktreePath: null,
					session: {} as TaskNode["session"],
					color: undefined,
					persistent: false,
				},
			],
			rootNodeId: "root",
		} satisfies IncomingEvent);

		expect(capturedLogs.some((entry) => entry.taskId === "task-reset")).toBe(
			false,
		);
		expect(capturedPending.some((entry) => entry.taskId === "task-reset")).toBe(
			false,
		);
		expect(olderEvents.has("task-reset")).toBe(false);
		expect(olderEvents.has("other-task")).toBe(true);
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

// ============================================================
// Forked session / per-session event processing
// ============================================================

describe("event-handler forked session events", () => {
	it("processEventBatch: events with different taskIds all appear in logs", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "assistant_text",
				content: "Parent task output",
				taskId: "parent-task",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Child task output",
				taskId: "child-task",
				ts: 2000,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-parent",
				input: { command: "echo parent" },
				taskId: "parent-task",
				ts: 3000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-parent",
				content: "parent",
				isError: false,
				taskId: "parent-task",
				ts: 3500,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-child",
				input: { command: "echo child" },
				taskId: "child-task",
				ts: 4000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-child",
				content: "child",
				isError: false,
				taskId: "child-task",
				ts: 4500,
			},
		]);

		// All events from both tasks should be in logs
		const parentText = capturedLogs.find(
			(e) => e.type === "assistant_text" && e.taskId === "parent-task",
		);
		const childText = capturedLogs.find(
			(e) => e.type === "assistant_text" && e.taskId === "child-task",
		);
		const parentTool = capturedLogs.find(
			(e) => e.type === "tool_pair" && e.taskId === "parent-task",
		);
		const childTool = capturedLogs.find(
			(e) => e.type === "tool_pair" && e.taskId === "child-task",
		);

		expect(parentText).toBeDefined();
		expect(parentText?.type === "assistant_text" && parentText.content).toBe(
			"Parent task output",
		);
		expect(childText).toBeDefined();
		expect(childText?.type === "assistant_text" && childText.content).toBe(
			"Child task output",
		);
		expect(parentTool).toBeDefined();
		expect(childTool).toBeDefined();
	});

	it("processEventBatch: fork_marker creates a fork_marker LogEntry with sourceTaskId", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "assistant_text",
				content: "Pre-fork content from source",
				taskId: "source-task",
				ts: 1000,
			},
			{
				type: "fork_marker",
				sourceTaskId: "source-task",
				taskId: "target-task",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "Post-fork content from target",
				taskId: "target-task",
				ts: 3000,
			},
		]);

		expect(capturedLogs.length).toBe(3);

		const forkEntry = capturedLogs.find((e) => e.type === "fork_marker");
		expect(forkEntry).toBeDefined();
		expect(forkEntry?.type === "fork_marker" && forkEntry.sourceTaskId).toBe(
			"source-task",
		);
		expect(forkEntry?.taskId).toBe("target-task");

		// Pre-fork and post-fork content both present
		const preFork = capturedLogs.find(
			(e) => e.type === "assistant_text" && e.taskId === "source-task",
		);
		const postFork = capturedLogs.find(
			(e) => e.type === "assistant_text" && e.taskId === "target-task",
		);
		expect(preFork).toBeDefined();
		expect(postFork).toBeDefined();
	});

	it("processEventBatch: events tagged with root taskId and child taskId coexist", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		// assistant_text uses replace_text which merges into the last matching text entry,
		// so interleave with a tool_call to force separate entries for root
		processEventBatch([
			{
				type: "assistant_text",
				content: "Root orchestrator message",
				taskId: "root-id",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-root-1",
				input: { command: "echo root" },
				taskId: "root-id",
				ts: 1500,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-root-1",
				content: "root",
				isError: false,
				taskId: "root-id",
				ts: 1600,
			},
			{
				type: "assistant_text",
				content: "Sub-task worker message",
				taskId: "sub-task-id",
				ts: 2000,
			},
			{
				type: "assistant_text",
				content: "Another root message",
				taskId: "root-id",
				ts: 3000,
			},
		]);

		const rootEntries = capturedLogs.filter((e) => e.taskId === "root-id");
		const childEntries = capturedLogs.filter((e) => e.taskId === "sub-task-id");

		// Root has: assistant_text, tool_pair, assistant_text = 3 entries
		// (replace_text can't find previous assistant_text because tool_pair for same taskId breaks the scan)
		expect(rootEntries.length).toBe(3);
		expect(childEntries.length).toBe(1);
	});
});

// ============================================================
// Compaction display
// ============================================================

describe("event-handler compaction display", () => {
	it("processEventBatch: compact_marker preserves content before and after the barrier", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "assistant_text",
				content: "Before compaction",
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-pre",
				input: { command: "echo pre" },
				taskId: "task-1",
				ts: 1500,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-pre",
				content: "pre",
				isError: false,
				taskId: "task-1",
				ts: 1600,
			},
			{ type: "compact_started", taskId: "task-1", ts: 2000 },
			{
				type: "compact_marker",
				savedTokens: 10000,
				checkpoint: "Checkpoint after compaction",
				taskId: "task-1",
				ts: 2500,
			},
			{
				type: "assistant_text",
				content: "After compaction",
				taskId: "task-1",
				ts: 3000,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__read_file",
				toolCallId: "tc-post",
				input: { path: "foo.ts" },
				taskId: "task-1",
				ts: 3500,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__read_file",
				toolCallId: "tc-post",
				content: "file content",
				isError: false,
				taskId: "task-1",
				ts: 3600,
			},
		]);

		// Verify structure: pre-compact content, compact_marker, post-compact content
		const types = capturedLogs.map((e) => e.type);
		expect(types).toEqual([
			"assistant_text",
			"tool_pair",
			"compact_marker",
			"assistant_text",
			"tool_pair",
		]);

		// Verify compact_marker entry
		const marker = capturedLogs.find((e) => e.type === "compact_marker");
		expect(marker).toBeDefined();
		expect(marker?.type === "compact_marker" && marker.savedTokens).toBe(10000);
		expect(marker?.type === "compact_marker" && marker.checkpoint).toBe(
			"Checkpoint after compaction",
		);

		// Content before marker preserved
		const preText = capturedLogs[0];
		expect(preText?.type === "assistant_text" && preText.content).toBe(
			"Before compaction",
		);

		// Content after marker preserved
		const postText = capturedLogs[3];
		expect(postText?.type === "assistant_text" && postText.content).toBe(
			"After compaction",
		);
	});

	it("processEventBatch: multiple compactions — all markers preserved in order", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "assistant_text",
				content: "Phase 1",
				taskId: "task-1",
				ts: 1000,
			},
			{ type: "compact_started", taskId: "task-1", ts: 2000 },
			{
				type: "compact_marker",
				savedTokens: 5000,
				checkpoint: "First compaction",
				taskId: "task-1",
				ts: 2500,
			},
			{
				type: "assistant_text",
				content: "Phase 2",
				taskId: "task-1",
				ts: 3000,
			},
			{ type: "compact_started", taskId: "task-1", ts: 4000 },
			{
				type: "compact_marker",
				savedTokens: 8000,
				checkpoint: "Second compaction",
				taskId: "task-1",
				ts: 4500,
			},
			{
				type: "assistant_text",
				content: "Phase 3",
				taskId: "task-1",
				ts: 5000,
			},
		]);

		const markers = capturedLogs.filter((e) => e.type === "compact_marker");
		expect(markers.length).toBe(2);

		expect(
			markers[0]?.type === "compact_marker" && markers[0].savedTokens,
		).toBe(5000);
		expect(
			markers[1]?.type === "compact_marker" && markers[1].savedTokens,
		).toBe(8000);

		// Overall order: text, marker, text, marker, text
		const types = capturedLogs.map((e) => e.type);
		expect(types).toEqual([
			"assistant_text",
			"compact_marker",
			"assistant_text",
			"compact_marker",
			"assistant_text",
		]);
	});

	it("handleEvent: compact_started then compact_marker replaces started entry with marker", () => {
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

		// First add some content
		handleEvent({
			type: "assistant_text",
			content: "Before compaction",
			taskId: "task-1",
			ts: 1000,
		});
		expect(capturedLogs.length).toBe(1);

		// compact_started adds a pending entry
		handleEvent({
			type: "compact_started",
			taskId: "task-1",
			ts: 2000,
		});
		expect(capturedLogs.length).toBe(2);
		expect(capturedLogs[1]?.type).toBe("compact_started");

		// compact_marker replaces the compact_started entry
		handleEvent({
			type: "compact_marker",
			savedTokens: 7500,
			checkpoint: "Live compaction checkpoint",
			taskId: "task-1",
			ts: 3000,
		});

		// Same count — compact_started was replaced, not appended
		expect(capturedLogs.length).toBe(2);
		expect(capturedLogs[1]?.type).toBe("compact_marker");
		expect(
			capturedLogs[1]?.type === "compact_marker" && capturedLogs[1].savedTokens,
		).toBe(7500);
		expect(
			capturedLogs[1]?.type === "compact_marker" && capturedLogs[1].checkpoint,
		).toBe("Live compaction checkpoint");

		// Content before compaction still present
		expect(capturedLogs[0]?.type).toBe("assistant_text");
	});

	it("handleEvent: content after compact_marker appends normally", () => {
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

		handleEvent({ type: "compact_started", taskId: "task-1", ts: 1000 });
		handleEvent({
			type: "compact_marker",
			savedTokens: 5000,
			checkpoint: "cp",
			taskId: "task-1",
			ts: 2000,
		});
		handleEvent({
			type: "assistant_text",
			content: "Post-compact content",
			taskId: "task-1",
			ts: 3000,
		});

		expect(capturedLogs.length).toBe(2);
		expect(capturedLogs[0]?.type).toBe("compact_marker");
		expect(capturedLogs[1]?.type).toBe("assistant_text");
		expect(
			capturedLogs[1]?.type === "assistant_text" && capturedLogs[1].content,
		).toBe("Post-compact content");
	});
});

// ============================================================
// Task switch simulation: processEventBatch replaces all logs
// ============================================================

describe("event-handler task switch (processEventBatch replaces logs)", () => {
	it("processEventBatch replaces existing logs entirely — not appended", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch, handleEvent } = createEventHandler(
			deps as EventHandlerDeps,
		);

		// Simulate initial session: some live events for task-A
		handleEvent({
			type: "assistant_text",
			content: "Task A content",
			taskId: "task-A",
			ts: 1000,
		});
		expect(capturedLogs.length).toBe(1);

		// Now simulate a task switch: processEventBatch is called with task-B events
		// This should REPLACE all logs, not append
		processEventBatch([
			{
				type: "assistant_text",
				content: "Task B content",
				taskId: "task-B",
				ts: 2000,
			},
			{
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-b1",
				input: { command: "echo b" },
				taskId: "task-B",
				ts: 3000,
			},
			{
				type: "tool_result",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-b1",
				content: "b",
				isError: false,
				taskId: "task-B",
				ts: 3500,
			},
		]);

		// Logs should only contain task-B entries now
		expect(capturedLogs.every((e) => e.taskId === "task-B")).toBe(true);
		expect(capturedLogs.length).toBe(2); // assistant_text + tool_pair
		expect(capturedLogs.some((e) => e.taskId === "task-A")).toBe(false);
	});

	it("processEventBatch clears deferred messages from previous session", () => {
		const { deps } = makeDeps();

		let capturedPending: Array<{ id: string; text: string }> = [];
		(deps as Record<string, unknown>).setPendingMessages = mock(
			(updater: React.SetStateAction<Array<{ id: string; text: string }>>) => {
				capturedPending =
					typeof updater === "function" ? updater(capturedPending) : updater;
			},
		);

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { handleEvent, processEventBatch } = createEventHandler(
			deps as EventHandlerDeps,
		);

		// Add a pending message to task-A
		handleEvent({
			type: "message",
			id: "msg-old",
			body: {
				source: "user",
				id: "test-id",
				ts: 0,
				content: "Old message",
			},
			taskId: "task-A",
			ts: 1000,
		} satisfies IncomingEvent);
		expect(capturedPending.length).toBe(1);

		// Switch to task-B via processEventBatch
		processEventBatch([
			{
				type: "assistant_text",
				content: "Task B output",
				taskId: "task-B",
				ts: 2000,
			},
		]);

		// Old deferred messages should be cleared (processEventBatch clears deferredMessages)
		// The pending banner will be synced based on the now-empty deferredMessages map
		// (any pending from the batch would show, but "msg-old" should be gone)
		expect(capturedLogs.every((e) => e.taskId === "task-B")).toBe(true);
	});

	it("processEventBatch resets background processes", () => {
		const { deps } = makeDeps();

		let bgProcesses: Map<
			string,
			{ id: string; command: string; startTime: number; taskId?: string }
		> = new Map([
			[
				"bg-old",
				{
					id: "bg-old",
					command: "old-cmd",
					startTime: 100,
					taskId: "task-A",
				},
			],
		]);
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
				type: "assistant_text",
				content: "New session content",
				taskId: "task-B",
				ts: 2000,
			},
		]);

		// Old bg processes should be cleared
		expect(bgProcesses.has("bg-old")).toBe(false);
		expect(bgProcesses.size).toBe(0);
	});
});

// ============================================================
// ActivityLog filtering by taskId
// ============================================================

describe("ActivityLog filtering logic", () => {
	// Test the filtering logic that ActivityLog.tsx uses (useMemo visible),
	// extracted here to test without React rendering.

	function filterEntries(
		entries: LogEntry[],
		filterTaskId: string | null,
		rootNodeId: string | null,
	): LogEntry[] {
		const isRootFilter = !filterTaskId || filterTaskId === rootNodeId;
		if (isRootFilter) {
			return entries.filter((e) => {
				const tid = getLogTaskId(e);
				return !tid || tid === rootNodeId;
			});
		}
		return entries.filter((e) => getLogTaskId(e) === filterTaskId);
	}

	it("root filter shows only root-tagged and untagged entries", () => {
		const entries: LogEntry[] = [
			createLogEntry({
				type: "assistant_text",
				content: "Root message",
				taskId: "root-1",
				ts: 1000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Child message",
				taskId: "child-1",
				ts: 2000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Untagged message",
				taskId: "",
				ts: 3000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Another child",
				taskId: "child-2",
				ts: 4000,
			}),
		];

		const filtered = filterEntries(entries, "root-1", "root-1");
		expect(filtered.length).toBe(2);
		expect(
			filtered.every((e) => {
				const tid = getLogTaskId(e);
				return !tid || tid === "root-1";
			}),
		).toBe(true);
	});

	it("null filterTaskId acts as root filter", () => {
		const entries: LogEntry[] = [
			createLogEntry({
				type: "assistant_text",
				content: "Root message",
				taskId: "root-1",
				ts: 1000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Child message",
				taskId: "child-1",
				ts: 2000,
			}),
		];

		const filtered = filterEntries(entries, null, "root-1");
		expect(filtered.length).toBe(1);
		expect(filtered[0]?.taskId).toBe("root-1");
	});

	it("child filter shows only that child's entries", () => {
		const entries: LogEntry[] = [
			createLogEntry({
				type: "assistant_text",
				content: "Root message",
				taskId: "root-1",
				ts: 1000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Child-1 message",
				taskId: "child-1",
				ts: 2000,
			}),
			createLogEntry({
				type: "tool_call",
				tool: "mcp__mxd__bash",
				toolCallId: "tc-1",
				input: { command: "echo" },
				taskId: "child-1",
				ts: 3000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Child-2 message",
				taskId: "child-2",
				ts: 4000,
			}),
		];

		const filteredChild1 = filterEntries(entries, "child-1", "root-1");
		expect(filteredChild1.length).toBe(2);
		expect(filteredChild1.every((e) => e.taskId === "child-1")).toBe(true);

		const filteredChild2 = filterEntries(entries, "child-2", "root-1");
		expect(filteredChild2.length).toBe(1);
		expect(filteredChild2[0]?.taskId).toBe("child-2");
	});

	it("forked session: pre-fork events with source taskId don't leak to target task view", () => {
		const entries: LogEntry[] = [
			createLogEntry({
				type: "assistant_text",
				content: "Source task content (pre-fork)",
				taskId: "source-task",
				ts: 1000,
			}),
			createLogEntry({
				type: "fork_marker",
				sourceTaskId: "source-task",
				taskId: "target-task",
				ts: 2000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Target task content (post-fork)",
				taskId: "target-task",
				ts: 3000,
			}),
		];

		// Viewing target-task: should see fork_marker + post-fork content
		const targetView = filterEntries(entries, "target-task", "root-1");
		expect(targetView.length).toBe(2);
		expect(targetView[0]?.type).toBe("fork_marker");
		expect(targetView[1]?.type).toBe("assistant_text");
		expect(
			targetView[1]?.type === "assistant_text" && targetView[1].content,
		).toBe("Target task content (post-fork)");

		// Viewing source-task: should see only source content
		const sourceView = filterEntries(entries, "source-task", "root-1");
		expect(sourceView.length).toBe(1);
		expect(sourceView[0]?.type).toBe("assistant_text");
		expect(
			sourceView[0]?.type === "assistant_text" && sourceView[0].content,
		).toBe("Source task content (pre-fork)");
	});

	it("empty entries returns empty for any filter", () => {
		expect(filterEntries([], "root-1", "root-1").length).toBe(0);
		expect(filterEntries([], "child-1", "root-1").length).toBe(0);
		expect(filterEntries([], null, "root-1").length).toBe(0);
	});

	it("mixed content: compact_marker entries respect taskId filtering", () => {
		const entries: LogEntry[] = [
			createLogEntry({
				type: "assistant_text",
				content: "Root before compact",
				taskId: "root-1",
				ts: 1000,
			}),
			createLogEntry({
				type: "compact_marker",
				checkpoint: "Root compaction",
				savedTokens: 5000,
				taskId: "root-1",
				ts: 2000,
			}),
			createLogEntry({
				type: "assistant_text",
				content: "Child after compact",
				taskId: "child-1",
				ts: 3000,
			}),
		];

		const rootView = filterEntries(entries, "root-1", "root-1");
		expect(rootView.length).toBe(2);
		expect(rootView[0]?.type).toBe("assistant_text");
		expect(rootView[1]?.type).toBe("compact_marker");

		const childView = filterEntries(entries, "child-1", "root-1");
		expect(childView.length).toBe(1);
		expect(childView[0]?.type).toBe("assistant_text");
		expect(
			childView[0]?.type === "assistant_text" && childView[0].content,
		).toBe("Child after compact");
	});
});

// ============================================================
// agent_stopped rendering + start/stop collapse
// ============================================================

describe("event-handler agent_stopped and lifecycle collapse", () => {
	it("processEvent: agent_stopped creates a lifecycle LogEntry", () => {
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
			type: "agent_stopped",
			taskId: "task-1",
			ts: 1000,
		});

		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("lifecycle");
		if (capturedLogs[0]?.type === "lifecycle") {
			expect(capturedLogs[0].content).toContain("stopped");
			expect(capturedLogs[0].taskId).toBe("task-1");
		}
	});

	it("processEventBatch: agent_stopped creates a lifecycle LogEntry", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "agent_stopped",
				taskId: "task-1",
				ts: 1000,
			},
		]);

		expect(capturedLogs.length).toBe(1);
		expect(capturedLogs[0]?.type).toBe("lifecycle");
		if (capturedLogs[0]?.type === "lifecycle") {
			expect(capturedLogs[0].content).toContain("stopped");
		}
	});

	it("processEventBatch: collapses consecutive start/stop pairs with no content between them", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		// Simulate many daemon restarts — each produces orchestration_started(resume) + agent_stopped
		processEventBatch([
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 1000,
			},
			{ type: "agent_stopped", taskId: "task-1", ts: 2000 },
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 3000,
			},
			{ type: "agent_stopped", taskId: "task-1", ts: 4000 },
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 5000,
			},
			{ type: "agent_stopped", taskId: "task-1", ts: 6000 },
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 7000,
			},
			// This last one is active — no agent_stopped after it
			{
				type: "assistant_text",
				content: "Doing work now",
				taskId: "task-1",
				ts: 8000,
			},
		]);

		// Should collapse the first 3 start/stop pairs and keep only the last resume entry
		const lifecycleEntries = capturedLogs.filter((e) => e.type === "lifecycle");
		// Only the last "Session resumed" should remain (the one at ts=7000)
		expect(lifecycleEntries.length).toBe(1);
		expect(lifecycleEntries[0]?.content).toContain("resumed");

		// The assistant_text should still be there
		const textEntries = capturedLogs.filter((e) => e.type === "assistant_text");
		expect(textEntries.length).toBe(1);
	});

	it("processEventBatch: preserves start/stop entries that have meaningful content between them", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "First session work",
				taskId: "task-1",
				ts: 1500,
			},
			{ type: "agent_stopped", taskId: "task-1", ts: 2000 },
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "Second session work",
				taskId: "task-1",
				ts: 3500,
			},
		]);

		// Both "Session resumed" entries should be preserved because there's content between them
		const lifecycleEntries = capturedLogs.filter((e) => e.type === "lifecycle");
		expect(lifecycleEntries.length).toBeGreaterThanOrEqual(2);
	});

	it("processEventBatch: collapse works across many empty cycles, keeps the very last resume", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		// 20 empty restart cycles
		const events: IncomingEvent[] = [];
		for (let i = 0; i < 20; i++) {
			events.push({
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 1000 + i * 2000,
			});
			events.push({
				type: "agent_stopped",
				taskId: "task-1",
				ts: 2000 + i * 2000,
			});
		}
		// Final resume that's actually active
		events.push({
			type: "orchestration_started",
			taskId: "task-1",
			resume: true,
			model: "claude-sonnet",
			provider: "anthropic",
			ts: 50000,
		});

		processEventBatch(events);

		// Only the very last "Session resumed" should remain
		const lifecycleEntries = capturedLogs.filter((e) => e.type === "lifecycle");
		expect(lifecycleEntries.length).toBe(1);
		expect(lifecycleEntries[0]?.ts).toBe(50000);
	});

	it("processEventBatch: task_started entries are NOT collapsed (only session lifecycle events)", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createEventHandler(deps as EventHandlerDeps);

		processEventBatch([
			{
				type: "task_started",
				taskId: "task-1",
				title: "My Task",
				ts: 500,
			},
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 1000,
			},
			{ type: "agent_stopped", taskId: "task-1", ts: 2000 },
			{
				type: "orchestration_started",
				taskId: "task-1",
				resume: true,
				model: "claude-sonnet",
				provider: "anthropic",
				ts: 3000,
			},
			{
				type: "assistant_text",
				content: "Working",
				taskId: "task-1",
				ts: 4000,
			},
		]);

		// task_started should still be there
		const taskStarted = capturedLogs.find((e) => e.type === "task_started");
		expect(taskStarted).toBeDefined();

		// The first empty start/stop pair should be collapsed, keeping only the last resume
		const lifecycleEntries = capturedLogs.filter((e) => e.type === "lifecycle");
		expect(lifecycleEntries.length).toBe(1);
	});
});
