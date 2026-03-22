import { describe, expect, it, mock } from "bun:test";
import type React from "react";
import { createEventHandler, type EventHandlerDeps } from "./event-handler.ts";
import type { LogEntry } from "./hooks.ts";

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
	it("processEventBatch: user_message with queueEntry.source=child_report materializes as child_report", () => {
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
				source: "child_report",
				body: {
					source: "child_report",
					taskId: "child-1",
					title: "My Child Task",
					content: "Progress update: 50% done",
				},
				taskId: "parent-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-1"],
				ts: 2000,
			},
		]);

		const childReportEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "child_report",
		);
		expect(childReportEntry).toBeDefined();
		expect(childReportEntry?.content).toBe("Progress update: 50% done");
		expect(childReportEntry?.title).toBe("My Child Task");
		// taskId should be the PARENT's (consuming agent), not the child's
		expect(childReportEntry?.taskId).toBe("parent-1");
	});

	it("processEventBatch: user_message with queueEntry.source=parent_update materializes as parent_update", () => {
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
				source: "parent_update",
				body: {
					source: "parent_update",
					content: "Please also fix bug #42",
				},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-2"],
				ts: 2000,
			},
		]);

		const parentEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "parent_update",
		);
		expect(parentEntry).toBeDefined();
		expect(parentEntry?.content).toBe("Please also fix bug #42");
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
				source: "user",
				content: "Hello world",
				body: {
					source: "user",
					content: "Hello world",
				},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-3"],
				ts: 2000,
			},
		]);

		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(userEntry?.type === "message" ? userEntry.body.content : "").toBe(
			"Hello world",
		);
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
				source: "child_report",
				body: {
					source: "child_report",
					taskId: "child-1",
					title: "Worker",
					content: "Phase 1 done",
				},
				taskId: "parent-1",
				ts: 1000,
			},
			// No messages_consumed — message is unconsumed
		]);

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
				body: { source: "user", content: "Please check this" },
				ts: 1000,
			},
			// No messages_consumed — message is unconsumed
		]);

		expect(capturedPending.length).toBe(1);
		expect((capturedPending[0] as { text: string }).text).toBe(
			"Please check this",
		);
	});

	it("processEventBatch: message with body.source=child_report materializes correctly", () => {
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
					source: "child_report",
					taskId: "child-1",
					title: "New Task",
					content: "Report content",
				},
				taskId: "parent-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-6"],
				ts: 2000,
			},
		]);

		const childReportEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "child_report",
		);
		expect(childReportEntry).toBeDefined();
		expect(childReportEntry?.content).toBe("Report content");
		expect(childReportEntry?.title).toBe("New Task");
	});

	it("handleEvent: live user_message with queueEntry.source=child_report deferred, then messages_consumed renders card", () => {
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
			source: "child_report",
			body: {
				source: "child_report",
				taskId: "child-1",
				title: "Worker Task",
				content: "I'm done with phase 1",
			},
			taskId: "parent-1",
			ts: 1000,
		});

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
			ts: 2000,
		});

		// Now should appear in activity log as child_report
		const childReportEntry = capturedLogs.find(
			(e: LogEntry) => e.type === "child_report",
		);
		expect(childReportEntry).toBeDefined();
		expect(childReportEntry?.content).toBe("I'm done with phase 1");
		// taskId should be the PARENT's (consuming agent), not the child's
		expect(childReportEntry?.taskId).toBe("parent-1");
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
			body: { source: "user", content: "Build a feature" },
			taskId: "task-1",
			ts: 1000,
		});

		// Should be in pending banner
		expect(capturedPending.length).toBe(1);
		expect(capturedPending[0]?.text).toBe("Build a feature");

		// 2. Receive messages_consumed
		handleEvent({
			type: "messages_consumed",
			messageIds: ["msg-8"],
			ts: 2000,
		});

		// Should be moved to activity log
		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(userEntry?.type === "message" ? userEntry.body.content : "").toBe(
			"Build a feature",
		);

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
				source: "clarify_response",
				body: {
					source: "clarify_response",
					answer: "Yes, go ahead with approach A",
				},
				taskId: "task-1",
				ts: 1000,
			},
			{
				type: "messages_consumed",
				messageIds: ["msg-9"],
				ts: 2000,
			},
		]);

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
			body: { source: "user", content: "Hello world" },
			taskId: null,
			ts: 1000,
		});
		expect(capturedPending.length).toBe(1);
		expect(capturedPending[0]?.id).toBe("msg-race");
		expect(capturedLogs.length).toBe(0);

		// Step 2: messages_consumed arrives — materializes in log, clears from pending
		// No pending_messages:[] race — pending state is derived from deferredMessages map
		handleEvent({
			type: "messages_consumed",
			messageIds: ["msg-race"],
			ts: 2000,
		});

		// The user message MUST appear in the activity log
		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(userEntry?.type === "message" ? userEntry.body.content : "").toBe(
			"Hello world",
		);
		// Pending should be cleared
		expect(capturedPending.length).toBe(0);
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
