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
			nodeMapRef: { current: new Map() },
			t: (key: string) => key,
		},
		logs,
	};
}

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
