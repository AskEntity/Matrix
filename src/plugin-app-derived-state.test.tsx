import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type React from "react";
import { createActionHandlers } from "../.mxd/plugin/web/handlers.ts";
import type { TaskNode } from "../.mxd/plugin/web/hooks.ts";

const originalLocalStorage = globalThis.localStorage;
beforeEach(() => {
	if (!globalThis.localStorage) {
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				_store: new Map<string, string>(),
				getItem(key: string) { return this._store.get(key) ?? null; },
				setItem(key: string, val: string) { this._store.set(key, val); },
				removeItem(key: string) { this._store.delete(key); },
				clear() { this._store.clear(); },
			},
			configurable: true,
		});
	}
});
afterEach(() => {
	if (originalLocalStorage) {
		Object.defineProperty(globalThis, "localStorage", { value: originalLocalStorage, configurable: true });
	}
});

function makeNode(id: string, title: string, parentId: string | null): TaskNode {
	return { id, title, description: `${title} description`, status: "pending", parentId, children: [], branch: null, worktreePath: null, cwd: null, updatedAt: "2026-04-01T00:00:00Z", createdAt: "2026-04-01T00:00:00Z", costUsd: 0, editedBy: "user" };
}

function makeDeps(overrides?: Partial<Record<string, unknown>>) {
	const calls: Record<string, unknown[]> = {};
	function tracker(name: string) {
		calls[name] = [];
		return mock((...args: unknown[]) => { calls[name]?.push(args[0]); });
	}

	const deps = {
		authFetch: mock(async () => new Response("{}", { status: 200 })) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
		projectId: "proj-1",
		selectedTaskId: "task-a",
		rootNodeId: "root",
		selectedNode: makeNode("task-a", "Task A", "root"),
		isOrchestratorNode: false,
		targetNodeId: "task-a",
		clarifyAnswers: {},
		pendingClarifications: [],
		addLog: mock(() => {}),
		setLogs: tracker("setLogs"),
		setLastTurns: tracker("setLastTurns"),
		setLastInputTokens: tracker("setLastInputTokens"),
		setLastCacheCreationTokens: tracker("setLastCacheCreationTokens"),
		setLastCacheReadTokens: tracker("setLastCacheReadTokens"),
		setLastOutputTokens: tracker("setLastOutputTokens"),
		setSelectedTaskId: tracker("setSelectedTaskId"),
		setRootNodeId: tracker("setRootNodeId"),
		setClarifyAnswers: tracker("setClarifyAnswers"),
		setPendingClarifications: tracker("setPendingClarifications"),
		setIsCreatingTask: tracker("setIsCreatingTask"),
		setTokenUsage: tracker("setTokenUsage"),
		setPendingMessages: tracker("setPendingMessages"),
		setBackgroundProcesses: tracker("setBackgroundProcesses"),
		setActiveAgents: tracker("setActiveAgents"),
		setOlderEventsAvailable: tracker("setOlderEventsAvailable"),
		start: mock(async () => {}),
		stop: mock(async () => {}),
		compact: mock(async () => {}),
		sendMessageToTask: mock(async () => {}),
		deleteTask: mock(async () => {}),
		stopTask: mock(async () => {}),
		clearTaskSession: mock(async () => {}),
		refreshTasks: mock(() => {}),
		t: (key: string) => key,
		...overrides,
	};

	return { deps: deps as Parameters<typeof createActionHandlers>[0], calls };
}

// handleAddProject + handleDeleteProject moved to shell — tests removed

describe("handleCreateTask selects the newly created task", () => {
	it("sets selectedTaskId to the new task's ID after creation", async () => {
		const newTaskId = "new-task-123";
		const mockAuthFetch = mock(async () => {
			return new Response(JSON.stringify({ id: newTaskId, title: "New Task" }), { status: 201, headers: { "Content-Type": "application/json" } });
		}) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
		const { deps, calls } = makeDeps({ authFetch: mockAuthFetch });

		const handlers = createActionHandlers(deps);
		await handlers.handleCreateTask("New Task");

		expect(calls.setSelectedTaskId).toContainEqual(newTaskId);
		expect(deps.refreshTasks).toHaveBeenCalled();
	});
});

describe("handleClearRootSession resets token counters", () => {
	it("clears lastTurns and token counters when clearing root session", async () => {
		const originalConfirm = globalThis.confirm;
		globalThis.confirm = () => true;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

		try {
			const { deps, calls } = makeDeps({ selectedTaskId: "root", isOrchestratorNode: true, selectedNode: null });
			const handlers = createActionHandlers(deps);
			await handlers.handleClearRootSession();

			expect(calls.setLastTurns).toContainEqual(null);
			expect(calls.setLastInputTokens).toContainEqual(null);
			expect(calls.setLastCacheCreationTokens).toContainEqual(null);
			expect(calls.setLastCacheReadTokens).toContainEqual(null);
			expect(calls.setLastOutputTokens).toContainEqual(null);
			expect(calls.setLogs).toContainEqual([]);
		} finally {
			globalThis.confirm = originalConfirm;
			globalThis.fetch = originalFetch;
		}
	});
});
