import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { createActionHandlers } from "../.mxd/plugin/web/handlers.ts";
import type { TaskNode } from "../.mxd/plugin/web/hooks.ts";

const originalLocalStorage = globalThis.localStorage;
beforeEach(() => {
	if (!globalThis.localStorage) {
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				_store: new Map<string, string>(),
				getItem(key: string) {
					return this._store.get(key) ?? null;
				},
				setItem(key: string, val: string) {
					this._store.set(key, val);
				},
				removeItem(key: string) {
					this._store.delete(key);
				},
				clear() {
					this._store.clear();
				},
			},
			configurable: true,
		});
	}
});
afterEach(() => {
	if (originalLocalStorage) {
		Object.defineProperty(globalThis, "localStorage", {
			value: originalLocalStorage,
			configurable: true,
		});
	}
});

function makeNode(
	id: string,
	title: string,
	parentId: string | null,
): TaskNode {
	return {
		id,
		title,
		description: `${title} description`,
		status: "pending",
		parentId,
		children: [],
		branch: null,
		worktreePath: null,
		cwd: null,
		updatedAt: "2026-04-01T00:00:00Z",
		createdAt: "2026-04-01T00:00:00Z",
		costUsd: 0,
		editedBy: "user",
		type: "task",
	};
}

function makeDeps(overrides?: Partial<Record<string, unknown>>) {
	const calls: Record<string, unknown[]> = {};
	function tracker(name: string) {
		calls[name] = [];
		return mock((...args: unknown[]) => {
			calls[name]?.push(args[0]);
		});
	}

	const deps = {
		authFetch: mock(
			async () => new Response("{}", { status: 200 }),
		) as unknown as (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => Promise<Response>,
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
		// No `stop` fake: the teardown call is gone from ActionHandlerDeps, so
		// a double for it would be a double for something production can no
		// longer reach.
		compact: mock(async () => {}),
		sendMessageToTask: mock(async () => {}),
		deleteTask: mock(async () => {}),
		interruptTask: mock(async () => {}),
		clearTaskSession: mock(async () => {}),
		refreshTasks: mock(() => {}),
		t: (key: string) => key,
		...overrides,
	};

	return { deps: deps as Parameters<typeof createActionHandlers>[0], calls };
}

// handleAddProject + handleDeleteProject moved to shell — tests removed

describe("/stop is the same verb as the Stop button beside the composer", () => {
	// "Stop" has one meaning for a user: end this turn. There is no second,
	// wider stop anywhere on the user-facing surface — tearing the session
	// down survives as a REST endpoint (and `mxd stop`) with no UI entry.
	//
	// ⚠️ Pinning "/stop does not error" would pass before AND after this
	// change; a fixture that cannot express the difference is evidence for
	// neither. What separates the two implementations is WHICH function runs
	// and on WHICH task, so that is what is asserted.
	// Driven through `handleSend`, which is the door the composer submits to —
	// slash detection included. Calling the private dispatcher would have
	// tested a step rather than the command.
	it("interrupts the turn of the task being VIEWED, not root", async () => {
		const { deps } = makeDeps();
		// The fixture is only the hard case while these two differ — if they
		// ever converge, the assertion below stops distinguishing "the viewed
		// task" from "root" and quietly proves nothing.
		expect(deps.targetNodeId).not.toBe(deps.rootNodeId);

		await createActionHandlers(deps).handleSend("/stop");

		expect(deps.interruptTask).toHaveBeenCalledTimes(1);
		expect(deps.interruptTask).toHaveBeenCalledWith(deps.targetNodeId);
		// Consumed as a command, not delivered as chat.
		expect(deps.sendMessageToTask).not.toHaveBeenCalled();
	});

	it("is a no-op before a task is resolved, rather than starting one cold", async () => {
		// targetNodeId is null only in the brand-new transient before
		// useTasks resolves. Reachable — and the wrong answer here is loud:
		// falling through to the chat path would `start()` an agent from a
		// command whose whole purpose is to stop one.
		const { deps } = makeDeps({ targetNodeId: null });

		await createActionHandlers(deps).handleSend("/stop");

		expect(deps.interruptTask).not.toHaveBeenCalled();
		expect(deps.start).not.toHaveBeenCalled();
		expect(deps.addLog).not.toHaveBeenCalled();
	});
});

describe("handleCreateTask selects the newly created task", () => {
	it("sets selectedTaskId to the new task's ID after creation", async () => {
		const newTaskId = "new-task-123";
		const mockAuthFetch = mock(async () => {
			return new Response(
				JSON.stringify({ id: newTaskId, title: "New Task" }),
				{ status: 201, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => Promise<Response>;
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
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
			})) as unknown as typeof fetch;

		try {
			const { deps, calls } = makeDeps({
				selectedTaskId: "root",
				isOrchestratorNode: true,
				selectedNode: null,
			});
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

/**
 * handleSend is the composer's submit path, and it is a SECOND gate on the
 * same rule the InputBar enforces — everything that reaches the network goes
 * through here, including any future caller that never renders a button.
 *
 * The composer half (button `disabled`, Enter, and the hint) is pinned in
 * `web/InputBar-image-requires-text.test.tsx`; the backend half at both REST
 * doors in `src/image-requires-text.test.ts`.
 */
describe("handleSend requires text — an image alone is not sendable", () => {
	const anImage = [{ base64: "iVBORw0KGgo=", mediaType: "image/png" }];

	it("does not send when there are images but no text", async () => {
		const { deps } = makeDeps();
		const handlers = createActionHandlers(deps);

		await handlers.handleSend("", anImage);

		expect(deps.sendMessageToTask).not.toHaveBeenCalled();
		expect(deps.start).not.toHaveBeenCalled();
	});

	it("does not send when the text is whitespace only", async () => {
		const { deps } = makeDeps();
		const handlers = createActionHandlers(deps);

		await handlers.handleSend("   \n\t ", anImage);

		expect(deps.sendMessageToTask).not.toHaveBeenCalled();
		expect(deps.start).not.toHaveBeenCalled();
	});

	it("REGRESSION: sends text WITH images, images intact", async () => {
		const { deps } = makeDeps();
		const handlers = createActionHandlers(deps);

		await handlers.handleSend("look at this", anImage);

		expect(deps.sendMessageToTask).toHaveBeenCalledWith(
			"task-a",
			"look at this",
			anImage,
		);
	});
});
