import { describe, expect, it, mock } from "bun:test";
import type React from "react";
import type { LogEntry } from "./hooks.ts";
import { createWSHandler, type WSHandlerDeps } from "./ws-handler.ts";

/** Minimal deps that satisfy the WSHandlerDeps interface */
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
			t: (key: string) => key,
		},
		logs,
	};
}

describe("ws-handler queueEntry handling", () => {
	it("processEventBatch: user_message with queueEntry.source=child_report materializes as child_report", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

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

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

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

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

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
		expect(userEntry?.content).toBe("Hello world");
	});

	it("processEventBatch: unconsumed non-user user_message goes to pendingMessages with descriptive text", () => {
		const { deps } = makeDeps();

		let capturedPending: unknown[] = [];
		(deps as Record<string, unknown>).setPendingMessages = mock(
			(updater: React.SetStateAction<unknown[]>) => {
				capturedPending = typeof updater === "function" ? updater([]) : updater;
			},
		);

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

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

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

		processEventBatch([
			{
				type: "message",
				id: "msg-5",
				content: "Please check this",
				ts: 1000,
			},
			// No messages_consumed — message is unconsumed
		]);

		expect(capturedPending.length).toBe(1);
		expect((capturedPending[0] as { text: string }).text).toBe(
			"Please check this",
		);
	});

	it("processEventBatch: legacy flat-field user_message (no queueEntry) materializes correctly", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

		// Legacy format: source + flat fields, no queueEntry
		processEventBatch([
			{
				type: "message",
				id: "msg-6",
				source: "child_report",
				taskId: "child-1",
				title: "Legacy Task",
				content: "Legacy report content",
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
		expect(childReportEntry?.content).toBe("Legacy report content");
		expect(childReportEntry?.title).toBe("Legacy Task");
	});

	it("handleWS: live user_message with queueEntry.source=child_report deferred, then messages_consumed renders card", () => {
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

		const { handleWS } = createWSHandler(deps as WSHandlerDeps);

		// 1. Receive user_message with queueEntry (non-user source)
		handleWS({
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
		handleWS({
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

	it("handleWS: live user_message (actual user) goes to pending, then messages_consumed moves to log", () => {
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

		const { handleWS } = createWSHandler(deps as WSHandlerDeps);

		// 1. Receive user_message (actual user)
		handleWS({
			type: "message",
			id: "msg-8",
			content: "Build a feature",
			taskId: "task-1",
			ts: 1000,
		});

		// Should be in pending banner
		expect(capturedPending.length).toBe(1);
		expect(capturedPending[0]?.text).toBe("Build a feature");

		// 2. Receive messages_consumed
		handleWS({
			type: "messages_consumed",
			messageIds: ["msg-8"],
			ts: 2000,
		});

		// Should be moved to activity log
		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(userEntry?.content).toBe("Build a feature");

		// Should be removed from pending
		expect(capturedPending.length).toBe(0);
	});

	it("processEventBatch: user_message with queueEntry.source=clarify_response materializes correctly", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((entries: React.SetStateAction<LogEntry[]>) => {
			capturedLogs = typeof entries === "function" ? entries([]) : entries;
		});

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

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

describe("ws-handler pending_messages race condition", () => {
	it("handleWS: user message appears in log even when pending_messages:[] clears before messages_consumed", () => {
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

		const { handleWS } = createWSHandler(deps as WSHandlerDeps);

		// Step 1: user_message arrives → goes to pending + deferredUserMsgs
		// taskId: null = root orchestrator message
		handleWS({
			type: "message",
			id: "msg-race",
			content: "Hello world",
			taskId: null,
			ts: 1000,
		});
		expect(capturedPending.length).toBe(1);
		expect(capturedPending[0]?.id).toBe("msg-race");
		expect(capturedLogs.length).toBe(0);

		// Step 2: pending_messages:[] arrives for root (taskId=null) BEFORE messages_consumed
		// This simulates the race: queue drains immediately when agent wakes, clearing the banner
		handleWS({
			type: "pending_messages",
			projectId: "proj-1",
			taskId: null,
			messages: [],
		});
		expect(capturedPending.length).toBe(0); // Banner cleared!

		// Step 3: messages_consumed arrives — should STILL create the log entry
		// even though pendingMessages was cleared
		handleWS({
			type: "messages_consumed",
			messageIds: ["msg-race"],
			ts: 2000,
		});

		// The user message MUST appear in the activity log
		const userEntry = capturedLogs.find((e: LogEntry) => e.type === "message");
		expect(userEntry).toBeDefined();
		expect(userEntry?.content).toBe("Hello world");
	});
});

describe("ws-handler compact_marker savedTokens", () => {
	it("processEvent returns savedTokens in the complete_compact UpdateOp", () => {
		const { deps } = makeDeps();
		// Smoke test: createWSHandler works without error
		createWSHandler(deps as WSHandlerDeps);
	});

	it("handleWS: compact_marker with savedTokens=5000 produces LogEntry with savedTokens=5000", () => {
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

		const { handleWS } = createWSHandler(deps as WSHandlerDeps);

		// First, add a compact_started entry
		handleWS({
			type: "compact_started",
			taskId: "task-1",
			ts: 1000,
		});

		// Now send compact_marker with savedTokens
		handleWS({
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

	it("handleWS: compact_marker fallback (no compact_started) also uses savedTokens", () => {
		const { deps } = makeDeps();

		let capturedLogs: LogEntry[] = [];
		deps.setLogs = mock((updater: React.SetStateAction<LogEntry[]>) => {
			if (typeof updater === "function") {
				capturedLogs = updater(capturedLogs);
			} else {
				capturedLogs = updater;
			}
		});

		const { handleWS } = createWSHandler(deps as WSHandlerDeps);

		// Send compact_marker without preceding compact_started
		handleWS({
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

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

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

		const { processEventBatch } = createWSHandler(deps as WSHandlerDeps);

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
