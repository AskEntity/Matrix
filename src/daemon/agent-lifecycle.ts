import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "../agent-provider.ts";
import {
	createOrchestratorTools,
	slugify,
	TASK_SYSTEM_PROMPT,
} from "../agent-tools.ts";
import { DEFAULT_MODEL } from "../config.ts";
import { type Event, findOrphanedToolCalls } from "../events.ts";
import { McpClientManager } from "../mcp-client.ts";
import type { QueueImage, QueueMessage } from "../message-queue.ts";
import { globalAgentQueues, MessageQueue } from "../message-queue.ts";
import {
	clearPersistedMessages,
	loadPersistedMessages,
	persistMessage,
} from "../persistent-queue.ts";
import type { TaskTracker } from "../task-tracker.ts";
import type { ToolDefinition } from "../tool-definition.ts";
import {
	cleanupSessionBackgroundProcesses,
	createBuiltinTools,
} from "../tools/index.ts";
import type { AgentResult, TaskSession } from "../types.ts";
import { ulid } from "../ulid.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import type { DaemonContext } from "./context.ts";
import {
	broadcast,
	broadcastTreeUpdate,
	emitEvent,
	removePendingClarification,
} from "./event-system.ts";
import {
	getEventStore,
	getProjectProvider,
	getTracker,
	readProjectMemory,
	resolveProjectConfig,
} from "./helpers.ts";

// All provider events flow through the emit() callback → emitEvent().
// No more AgentEvent→Event conversion layer.
// The onTaskEvent callback in createAgentContext still handles agent_event
// wrappers from MCP tools (child agents forwarding events to parent).

// ---------------------------------------------------------------------------
// Shared helpers — extracted from launchAgent / runChildAgentInBackground
// ---------------------------------------------------------------------------

/** Config + tools bundle produced by createAgentContext(). */
interface AgentContextResult {
	provider: ReturnType<typeof getProjectProvider>;
	effectiveCfg: Awaited<ReturnType<typeof resolveProjectConfig>>;
	mcpManager: McpClientManager;
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic is not narrowable here
	mcpToolDefs: Record<string, ToolDefinition<any>[]>;
	hasRunningChildren?: () => boolean;
}

/**
 * Resolve project config, create a provider, connect external MCP servers,
 * and build orchestrator tools. Shared setup for both launchAgent and
 * runChildAgentInBackground.
 */
async function createAgentContext(
	ctx: DaemonContext,
	project: { id: string; path: string },
	opts: {
		tracker: TaskTracker;
		projectPath: string;
		currentTaskId: string;
		depth: number;
		queue: MessageQueue;
		childModel?: string;
		mcpManager?: McpClientManager;
		/** System prompt for auto-launching target project agents (cross-project). Only needed at depth 0. */
		orchestratorSystemPrompt?: string;
		/** Callback to look up TaskSession by sessionId. Needed for built-in tool handlers. */
		getSession: (sessionId: string) => TaskSession | undefined;
	},
): Promise<AgentContextResult> {
	const effectiveCfg = await resolveProjectConfig(
		ctx,
		project.path,
		project.id,
	);
	const provider = getProjectProvider(ctx, effectiveCfg);

	const mcpManager = opts.mcpManager ?? new McpClientManager();
	if (
		effectiveCfg.mcpServers &&
		Object.keys(effectiveCfg.mcpServers).length > 0
	) {
		await mcpManager.connectAll(effectiveCfg.mcpServers);
	}

	const wtRoot = join(project.path, ".worktrees");
	const wm = new WorktreeManager(project.path, wtRoot);

	const { toolDefs, hasRunningChildren } = createOrchestratorTools({
		tracker: opts.tracker,
		provider,
		worktrees: wm,
		projectPath: opts.projectPath,
		repoPath: project.path,
		currentTaskId: opts.currentTaskId,
		depth: opts.depth,
		childModel: opts.childModel ?? effectiveCfg.childModel,
		queue: opts.queue,
		defaultBudgetUsd: effectiveCfg.budgetUsd,
		clarifyTimeoutMs: effectiveCfg.clarifyTimeoutMs,
		maxDepth: effectiveCfg.maxDepth,
		projectManager: opts.depth === 0 ? ctx.pm : undefined,
		currentProjectId: project.id,
		clearSession: (taskId: string) =>
			getEventStore(ctx, project.id).clear(taskId),
		dataDir: ctx.config.dataDir,
		closeQueue: opts.depth > 0 ? () => opts.queue.close() : undefined,
		onTaskEvent: (event) => {
			console.error(event.type, event.taskId);
			const ts = (event.ts as number) || Date.now();
			// Transform agent_event wrappers into flat Events
			if (event.type === "agent_event") {
				const taskId = (event.taskId as string) || "";
				const eventType = event.eventType as string;
				const { type: _t, taskId: _tid, eventType: _et, ...rest } = event;
				// Construct a proper Event from the wrapper fields
				emitEvent(ctx, project.id, {
					type: eventType,
					taskId,
					ts,
					...rest,
				} as unknown as Event);
			} else {
				// Already a valid Event shape — just ensure ts
				const withTs = event.ts ? event : { ...event, ts };
				emitEvent(ctx, project.id, withTs as unknown as Event);
			}
			broadcastTreeUpdate(ctx, project.id, opts.tracker);
		},
		getParentQueue:
			opts.depth > 0
				? () => findParentQueue(opts.tracker, opts.currentTaskId)?.queue
				: undefined,
		broadcastTreeUpdate: () =>
			broadcastTreeUpdate(ctx, project.id, opts.tracker),
		isProjectActive:
			opts.depth === 0
				? (projectId: string) => ctx.activeSessions.has(projectId)
				: undefined,
		getProjectRootQueue:
			opts.depth === 0
				? (projectId: string) => {
						const t = ctx.trackers.get(projectId);
						if (!t?.rootNodeId) return undefined;
						return globalAgentQueues.get(t.rootNodeId);
					}
				: undefined,
		deliverMessage: async (nodeId: string, message: QueueMessage) => {
			await deliverMessage(ctx, project, nodeId, message);
		},
		injectMessageToProject:
			opts.depth === 0 && opts.orchestratorSystemPrompt
				? async (projectId: string, message: string) => {
						return handleInjectMessage(
							ctx,
							projectId,
							message,
							undefined,
							opts.orchestratorSystemPrompt,
						);
					}
				: undefined,
	});

	// Create built-in tools with handler closures that read session state
	const builtinTools = createBuiltinTools(
		opts.getSession,
		opts.currentTaskId,
		() => opts.getSession(opts.currentTaskId)?.cwd ?? opts.projectPath,
		() => opts.getSession(opts.currentTaskId)?.fallbackCwd,
		() => opts.getSession(opts.currentTaskId)?.queue,
	);

	const mcpToolDefs: Record<string, ToolDefinition[]> = {
		opengraft: [...builtinTools, ...toolDefs],
		...mcpManager.getToolDefs(),
	};

	return {
		provider,
		effectiveCfg,
		mcpManager,
		mcpToolDefs,
		hasRunningChildren,
	};
}

/**
 * Consume all events from a session's async generator.
 * All broadcasting is handled by the provider's emit() callback.
 * This just drives the generator to completion and returns the final result.
 */
async function consumeAgentEvents(
	events: AsyncGenerator<Event, AgentResult>,
): Promise<AgentResult> {
	let result = await events.next();
	while (!result.done) {
		result = await events.next();
	}
	return result.value;
}

// ---------------------------------------------------------------------------
// runChildCore — shared child agent lifecycle for both MCP and daemon paths
// ---------------------------------------------------------------------------

/** Parameters for runChildCore(). */
export interface RunChildCoreParams {
	/** The agent provider to use for streaming. */
	provider: AgentProvider;
	/** Task tracker for status checks (done() detection). */
	tracker: TaskTracker;
	/** Task node ID for the child agent. */
	taskId: string;
	/** Pre-created MessageQueue for the child. If omitted, a new one is created. */
	queue?: MessageQueue;
	/** Full AgentRequest to pass to provider.stream(). Queue will be set on the request. */
	sessionRequest: AgentRequest;
	/** Config for loading persisted messages from disk. Omit to skip. */
	persistedMessages?: {
		dataDir: string;
		projectId: string;
	};
}

/**
 * Shared child agent lifecycle: queue setup → stream events with done() detection → cleanup.
 *
 * Used by `runChildAgentInBackground` for all child agents (both MCP and daemon paths).
 *
 * Done detection: done() handler calls closeQueue() directly (via OrchestratorToolsDeps),
 * which closes the queue before waitForQueueMessages() blocks. The fallback path detects
 * tool_result for mcp__opengraft__done and closes the queue (handles edge cases).
 */
export async function runChildCore(
	params: RunChildCoreParams,
): Promise<AgentResult> {
	const { provider, tracker, taskId, sessionRequest, persistedMessages } =
		params;

	// Use pre-created queue or create a new one
	const childQueue = params.queue ?? new MessageQueue();
	globalAgentQueues.set(taskId, childQueue);
	sessionRequest.queue = childQueue;

	// Load any persisted messages from disk and enqueue them
	if (persistedMessages) {
		const persisted = await loadPersistedMessages(
			persistedMessages.dataDir,
			persistedMessages.projectId,
			taskId,
		);
		for (const msg of persisted) {
			childQueue.enqueue(msg);
		}
		if (persisted.length > 0) {
			await clearPersistedMessages(
				persistedMessages.dataDir,
				persistedMessages.projectId,
				taskId,
			);
		}
	}

	try {
		const stream = provider.stream(sessionRequest);
		let result = await stream.next();
		while (!result.done) {
			const event = result.value;

			// Fallback done() detection via tool_result. The primary path is
			// done() calling closeQueue() directly. This fallback handles edge
			// cases where done() completes without blocking.
			if (
				event.type === "tool_result" &&
				"tool" in event &&
				event.tool === "mcp__opengraft__done"
			) {
				const nodeStatus = tracker.get(taskId)?.status;
				if (nodeStatus === "passed" || nodeStatus === "failed") {
					childQueue.close();
					// Drain remaining events until the generator exits
					result = await stream.next();
					while (!result.done) {
						result = await stream.next();
					}
					return result.value;
				}
			}

			result = await stream.next();
		}
		return result.value;
	} finally {
		globalAgentQueues.delete(taskId);
		childQueue.close();
	}
}

// ---------------------------------------------------------------------------

/**
 * Write synthetic tool_result events for any unpaired tool_call at the end of JSONL.
 * Called during stopAgent to prevent orphaned tool_use errors on resume.
 * The event converter also has a fix for this (fixOrphanedAnthropicToolUse),
 * but writing to JSONL is cleaner — the fix persists and avoids repeated synthesis.
 */
async function writeOrphanedToolResults(
	eventStore: import("../event-store.ts").EventStore,
	sessionId: string,
): Promise<void> {
	if (!eventStore.has(sessionId)) return;

	const events = eventStore.readActive(sessionId);
	if (events.length === 0) return;

	// Scan backwards for trailing tool_call events without matching tool_result
	const orphanedToolCallIds: Array<{ toolCallId: string; tool: string }> = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i] as Event;
		if (event.type === "tool_call") {
			orphanedToolCallIds.push({
				toolCallId: event.toolCallId,
				tool: event.tool,
			});
		} else if (event.type === "tool_result") {
			// Found a tool_result — everything before this is already paired
			break;
		} else if (event.type === "assistant_text" || event.type === "message") {
			// Hit a non-tool event — stop scanning
			break;
		}
		// Skip lifecycle events and continue scanning
	}

	if (orphanedToolCallIds.length === 0) return;

	console.warn(
		`[stopAgent] Writing synthetic tool_result for ${orphanedToolCallIds.length} orphaned tool_call(s) in session ${sessionId}:`,
		orphanedToolCallIds.map((t) => t.toolCallId),
	);

	const syntheticEvents: Event[] = orphanedToolCallIds.map(
		({ toolCallId }) => ({
			type: "tool_result" as const,
			toolCallId,
			content:
				"Tool execution was interrupted by daemon restart. Results were lost.",
			isError: true,
			ts: Date.now(),
		}),
	);

	// Await to ensure write completes before process.exit during shutdown
	await eventStore.appendBatch(sessionId, syntheticEvents);
}

/**
 * Stop a running agent and clean up all associated state.
 * Single path for all stop operations (explicit stop, restart, project delete).
 */
export async function stopAgent(
	ctx: DaemonContext,
	projectId: string,
): Promise<void> {
	const session = ctx.activeSessions.get(projectId);
	if (!session) return;

	const tracker = ctx.trackers.get(projectId);

	session.stop();
	ctx.activeSessions.delete(projectId);

	// Cascade stop to ALL agents (root + children) via unified globalAgentQueues
	if (tracker) {
		const rootNodeId = tracker.rootNodeId;
		// Close root queue from unified registry
		if (rootNodeId) {
			const rootQueue = globalAgentQueues.get(rootNodeId);
			if (rootQueue) {
				globalAgentQueues.delete(rootNodeId);
				rootQueue.close();
			}
			// Clean up root session
			const rootNode = tracker.get(rootNodeId);
			if (rootNode?.session) {
				cleanupSessionBackgroundProcesses(rootNode.session.backgroundProcesses);
				rootNode.session = undefined;
			}
		}
		for (const node of tracker.allNodes()) {
			if (node.status === "in_progress" && node.id !== rootNodeId) {
				const childQueue = globalAgentQueues.get(node.id);
				if (childQueue) {
					globalAgentQueues.delete(node.id);
					childQueue.close();
				}
				// Clean up child session
				if (node.session) {
					cleanupSessionBackgroundProcesses(node.session.backgroundProcesses);
					node.session = undefined;
				}
				tracker.updateStatus(node.id, "failed");
			}
		}
		await tracker.save();
		broadcastTreeUpdate(ctx, projectId, tracker);
	}

	// Clear pending clarifications
	ctx.pendingClarifications.delete(projectId);
	broadcast(ctx.sseClients, projectId, {
		type: "pending_clarifications",
		projectId,
		clarifications: [],
	});

	// Defense-in-depth: write synthetic tool_result for any unpaired tool_call at end of JSONL.
	// This prevents orphaned tool_use errors on resume — the converter fix handles it too,
	// but writing to JSONL is cleaner since it persists the fix.
	if (tracker) {
		const eventStore = getEventStore(ctx, projectId);
		for (const node of tracker.allNodes()) {
			await writeOrphanedToolResults(eventStore, node.id);
		}
	}

	const rootNodeId = tracker?.rootNodeId;
	emitEvent(ctx, projectId, {
		type: "agent_stopped",
		...(rootNodeId ? { taskId: rootNodeId } : {}),
		ts: Date.now(),
	});
}

/**
 * Unified message delivery: try direct queue delivery, persist + launch if no running agent.
 *
 * This is the SINGLE path for delivering a message to any task (child or root).
 * Queue = cache, persist = disk. If cache hit (agent running) → enqueue directly,
 * no disk write needed. If cache miss → persist to disk, then launch agent which
 * loads persisted messages on startup.
 *
 * For child nodes, auto-launches the agent via ensureChildAgentRunning.
 * For root nodes, returns "persisted" so the caller can handle launch
 * (root launch requires orchestratorSystemPrompt and resume logic).
 *
 * Callers should NOT include the message content in any launch prompt — the agent
 * will receive it via queue drain of persisted messages.
 *
 * @returns "enqueued" if delivered to a running agent's queue,
 *          "persisted" if written to disk (agent not running).
 */
export async function deliverMessage(
	ctx: DaemonContext,
	project: { id: string; path: string },
	nodeId: string,
	message: QueueMessage,
): Promise<"enqueued" | "persisted"> {
	const tracker = await getTracker(ctx, project.id);

	// 1. Try direct queue delivery (unified registry — root + child queues)
	const queue = globalAgentQueues.get(nodeId);
	if (queue) {
		try {
			queue.enqueue(message);
			return "enqueued";
		} catch {
			// Queue was closed — fall through to persist + launch
		}
	}

	// 2. No running agent — persist to disk
	await persistMessage(ctx.config.dataDir, project.id, nodeId, message);

	// 4. Auto-launch for child nodes only. Root launch requires caller-specific
	// logic (orchestratorSystemPrompt, resume detection) — caller handles it.
	const node = tracker.get(nodeId);
	if (node?.parentId) {
		ensureChildAgentRunning(ctx, project, tracker, nodeId).catch((e) => {
			emitEvent(ctx, project.id, {
				type: "error",
				taskId: nodeId,
				message: `Auto-launch failed: ${e instanceof Error ? e.message : String(e)}`,
				ts: Date.now(),
			});
		});
	}

	return "persisted";
}

/**
 * Ensure a child task has a worktree and a running agent.
 * Creates the worktree if needed, sets status to in_progress, and launches
 * the agent via runChildAgentInBackground. Shared by the REST message
 * endpoint and any other daemon-level code that needs to auto-launch a child.
 */
export async function ensureChildAgentRunning(
	ctx: DaemonContext,
	project: { id: string; path: string },
	tracker: TaskTracker,
	nodeId: string,
	model?: string,
): Promise<void> {
	const node = tracker.get(nodeId);
	if (!node) return;

	// Guard: if agent is already running, do nothing (message was already enqueued by deliverMessage)
	const existingQueue = globalAgentQueues.get(nodeId);
	if (existingQueue) {
		return;
	}

	// Create worktree if the task doesn't have one yet
	if (!node.worktreePath) {
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);
		const wt = await wm.create(node.id, slugify(node.title));
		tracker.assignWorktree(node.id, wt.branch, wt.path);
	}

	tracker.updateStatus(nodeId, "in_progress");
	await tracker.save();

	emitEvent(ctx, project.id, {
		type: "task_started",
		taskId: nodeId,
		title: node.title,
		ts: Date.now(),
	});
	broadcastTreeUpdate(ctx, project.id, tracker);

	// The real user/parent message is persisted to disk and will be delivered
	// via queue drain (runChildCore loads persisted messages).
	// The message's header field contains task context + working dir.
	await runChildAgentInBackground(ctx, project, tracker, nodeId, model);
}

/** Compute the depth of a task in the tree by walking up the parentId chain. */
function computeDepth(tracker: TaskTracker, nodeId: string): number {
	let depth = 0;
	let current = tracker.get(nodeId);
	while (current?.parentId) {
		depth++;
		current = tracker.get(current.parentId);
	}
	return depth;
}

/**
 * Find the nearest ancestor with an active queue for a given node.
 * Walks up the parent chain to bubble through non-running intermediate nodes.
 * Returns both the queue and the ID of the ancestor it belongs to.
 */
/**
 * Find the nearest ancestor with an active queue for a given node.
 * Walks up the parent chain to bubble through non-running intermediate nodes.
 * Returns both the queue and the ID of the ancestor it belongs to.
 *
 * Exported so agent-tools.ts can use it for dynamic parent queue lookup.
 */
export function findParentQueue(
	tracker: TaskTracker,
	nodeId: string,
): { queue: MessageQueue; targetId: string } | undefined {
	const node = tracker.get(nodeId);
	if (!node?.parentId) return undefined;

	let targetId: string | null = node.parentId;
	while (targetId) {
		const queue = globalAgentQueues.get(targetId);
		if (queue) return { queue, targetId };

		const ancestor = tracker.get(targetId);
		if (!ancestor) break;

		// Reached root without finding a queue — root isn't running
		if (!ancestor.parentId) break;

		targetId = ancestor.parentId;
	}

	return undefined;
}

/** Run a child agent in the background for a specific task node. */
export async function runChildAgentInBackground(
	ctx: DaemonContext,
	project: { id: string; path: string },
	tracker: TaskTracker,
	nodeId: string,
	_model?: string,
): Promise<void> {
	const node = tracker.get(nodeId);
	if (!node?.worktreePath) return;

	const mcpManager = new McpClientManager();
	try {
		// Compute depth from the tree
		const depth = computeDepth(tracker, nodeId);

		// Create the queue first — shared between MCP tools and runChildCore
		const childQueue = new MessageQueue();

		// Create and attach TaskSession to the node
		const taskSession: TaskSession = {
			queue: childQueue,
			cwd: node.worktreePath as string,
			fallbackCwd: node.worktreePath as string,
			depth,
			backgroundProcesses: new Map(),
			foregroundExecutions: new Map(),
		};
		node.session = taskSession;

		// getSession lookup: find session from tracker by sessionId
		const getSession = (sid: string) => tracker.get(sid)?.session;

		const agentCtx = await createAgentContext(ctx, project, {
			tracker,
			projectPath: node.worktreePath as string,
			currentTaskId: nodeId,
			depth,
			queue: childQueue,
			mcpManager,
			getSession,
		});

		// Read active events for resume and fix orphaned tool_calls
		const eventStore = getEventStore(ctx, project.id);
		let activeEvents = eventStore.has(nodeId)
			? eventStore.readActive(nodeId)
			: [];
		if (activeEvents.length > 0) {
			const orphanFixes = findOrphanedToolCalls(activeEvents);
			if (orphanFixes.length > 0) {
				await eventStore.appendBatch(nodeId, orphanFixes);
				activeEvents = [...activeEvents, ...orphanFixes];
			}
		}

		// Build emit callback: emitEvent with taskId injected
		const emitWithTask = (event: Event) => {
			const withTaskId = { ...event, taskId: nodeId };
			emitEvent(ctx, project.id, withTaskId as Event);
		};

		const agentResult = await runChildCore({
			provider: agentCtx.provider,
			tracker,
			taskId: nodeId,
			queue: childQueue,
			sessionRequest: {
				cwd: node.worktreePath as string,
				emit: emitWithTask,
				activeEvents,
				systemPrompt: TASK_SYSTEM_PROMPT,
				resumeSessionId: nodeId,
				model: agentCtx.effectiveCfg.model,
				mcpToolDefs: agentCtx.mcpToolDefs,
				hasRunningChildren: agentCtx.hasRunningChildren,
				getSession,
			},
			persistedMessages: {
				dataDir: ctx.config.dataDir,
				projectId: project.id,
			},
		});

		// --- Post-completion logic (unified for both MCP and daemon paths) ---

		// Cost reporting
		if (agentResult.costUsd) {
			tracker.updateCost(nodeId, agentResult.costUsd);
		}

		// Budget exceeded check
		const updatedNode = tracker.get(nodeId);
		if (
			updatedNode?.budgetUsd &&
			updatedNode.costUsd &&
			updatedNode.costUsd > updatedNode.budgetUsd
		) {
			emitEvent(ctx, project.id, {
				type: "budget_exceeded",
				taskId: nodeId,
				title: node.title,
				costUsd: updatedNode.costUsd,
				budgetUsd: updatedNode.budgetUsd,
				ts: Date.now(),
			});
		}

		// done() tool updates status directly in the tracker.
		// Only update status here if done() wasn't called (agent exited without calling done()).
		const currentNode = tracker.get(nodeId);
		const doneWasCalled =
			currentNode?.status === "passed" || currentNode?.status === "failed";
		const success = doneWasCalled
			? currentNode?.status === "passed"
			: agentResult.success;

		if (!doneWasCalled) {
			let newStatus: "passed" | "failed" | "stuck";
			if (agentResult.success) {
				newStatus = "passed";
				node.failCount = 0;
			} else {
				node.failCount = (node.failCount ?? 0) + 1;
				newStatus = node.failCount >= 3 ? "stuck" : "failed";
			}
			tracker.updateStatus(nodeId, newStatus);
		}
		await tracker.save();

		// Fallback child_complete delivery: only when done() was NOT called.
		// When done() was called, it already delivered child_complete directly to the parent queue.
		// This handles agents that exit without calling done() (daemon restart, error, budget exceeded).
		if (!doneWasCalled) {
			const completionOutput = (agentResult.output ?? "").slice(0, 2000);
			const completionResult = findParentQueue(tracker, nodeId);
			const completionNotification = {
				source: "child_complete" as const,
				taskId: nodeId,
				title: node.title,
				success: success ?? true,
				output: completionOutput,
			};
			if (completionResult?.queue) {
				try {
					completionResult.queue.enqueue(completionNotification);
				} catch {
					// Queue may be closed if parent already finished
				}
			}
			// Always persist to immediate parent for its eventual resumption
			if (
				node.parentId &&
				(!completionResult?.queue ||
					completionResult.targetId !== node.parentId)
			) {
				await persistMessage(
					ctx.config.dataDir,
					project.id,
					node.parentId,
					completionNotification,
				);
			}
		}

		broadcastTreeUpdate(ctx, project.id, tracker);
	} catch (e) {
		tracker.updateStatus(nodeId, "stuck");
		await tracker.save();
		const errorMsg = e instanceof Error ? e.message : String(e);
		emitEvent(ctx, project.id, {
			type: "error",
			taskId: nodeId,
			message: `Child agent error: ${errorMsg}`,
			ts: Date.now(),
		});

		// Enqueue child_complete (failure) to parent's queue (bubbles up through non-running intermediates)
		const errorResult = findParentQueue(tracker, nodeId);
		const errorNotification = {
			source: "child_complete" as const,
			taskId: nodeId,
			title: node.title,
			success: false,
			output: `Error: ${errorMsg}`,
		};
		if (errorResult?.queue) {
			try {
				errorResult.queue.enqueue(errorNotification);
			} catch {
				// Queue may be closed
			}
		}
		// Always persist to immediate parent for its eventual resumption
		if (
			node.parentId &&
			(!errorResult?.queue || errorResult.targetId !== node.parentId)
		) {
			await persistMessage(
				ctx.config.dataDir,
				project.id,
				node.parentId,
				errorNotification,
			);
		}

		broadcastTreeUpdate(ctx, project.id, tracker);
	} finally {
		// Clean up session: background processes + detach from node
		const finalNode = tracker.get(nodeId);
		if (finalNode?.session) {
			cleanupSessionBackgroundProcesses(finalNode.session.backgroundProcesses);
			finalNode.session = undefined;
		}
		await mcpManager.disconnectAll();
	}
}

/**
 * Launch an agent for a project. Returns immediately.
 * The agent runs in the background; observe via WebSocket.
 * Uses startSession() for message injection support.
 */
export async function launchAgent(
	ctx: DaemonContext,
	project: { id: string; path: string },
	opts: {
		resume?: boolean;
		model?: string;
		childModel?: string;
	},
	orchestratorSystemPrompt: string,
) {
	const tracker = ctx.trackers.get(project.id);
	if (!tracker) return;

	// Ensure root node exists for the orchestrator
	const rootNode = tracker.ensureRootNode("Orchestrator", "");
	const rootNodeId = rootNode.id;
	tracker.updateStatus(rootNodeId, "in_progress");
	tracker.save().catch(() => {});

	const queue = new MessageQueue();

	// Load any persisted messages from disk and enqueue them
	const persistedMsgs = await loadPersistedMessages(
		ctx.config.dataDir,
		project.id,
		rootNodeId,
	);
	for (const msg of persistedMsgs) {
		queue.enqueue(msg);
	}
	if (persistedMsgs.length > 0) {
		await clearPersistedMessages(ctx.config.dataDir, project.id, rootNodeId);
	}

	const mcpManager = new McpClientManager();

	// getSession lookup: find session from tracker by sessionId
	const getSession = (sid: string) => tracker.get(sid)?.session;

	const agentCtx = await createAgentContext(ctx, project, {
		tracker,
		projectPath: project.path,
		currentTaskId: rootNodeId,
		depth: 0,
		childModel: opts.childModel,
		queue,
		mcpManager,
		orchestratorSystemPrompt,
		getSession,
	});

	// Priority: API param > resolved config
	const effectiveModel = opts.model ?? agentCtx.effectiveCfg.model;

	emitEvent(ctx, project.id, {
		type: "orchestration_started",
		taskId: rootNodeId,
		resume: opts.resume ?? false,
		// prompt field removed — messages are now delivered via queue with unified schema
		provider: agentCtx.provider.name,
		model: effectiveModel ?? DEFAULT_MODEL,
		ts: Date.now(),
	});
	broadcastTreeUpdate(ctx, project.id, tracker);

	// sessionId = taskId: orchestrator's session is always its rootNodeId.
	// The provider loads the session file if it exists.
	const resumeSessionId = rootNodeId;

	// Append self-bootstrap mode instructions if enabled
	let systemPrompt = orchestratorSystemPrompt;
	if (agentCtx.effectiveCfg.selfBootstrap) {
		systemPrompt +=
			"\n\n## Self-Bootstrap Mode\nThis project is the tool's own codebase. The user may ask you to test features by interacting with the system in unconventional ways (e.g., testing resume on passed tasks, calling tools in unexpected sequences). When the user gives explicit instructions that conflict with your standard workflow, prioritize the user's instructions. You are modifying your own source code — be extra careful but also extra flexible.\n\nWhen running in self-bootstrap mode, bugs you introduced may break features you depend on. The system may not behave as documented — your own changes may have altered its behavior in ways you can't observe from inside. The user can see the actual system state via the UI. When they give you instructions that seem redundant, illogical, or contradictory to how the system should work, follow them immediately — they're guiding you through a workaround for a bug in your own code. Don't argue or explain how it should work; just do what they say. The workarounds are temporary until the fix is merged and the daemon restarts with new code.";
	}

	// Read active events for resume and fix orphaned tool_calls
	const eventStore = getEventStore(ctx, project.id);
	let rootActiveEvents = eventStore.has(rootNodeId)
		? eventStore.readActive(rootNodeId)
		: [];
	if (rootActiveEvents.length > 0) {
		const orphanFixes = findOrphanedToolCalls(rootActiveEvents);
		if (orphanFixes.length > 0) {
			await eventStore.appendBatch(rootNodeId, orphanFixes);
			rootActiveEvents = [...rootActiveEvents, ...orphanFixes];
		}
	}

	// Build emit callback: emitEvent with taskId injected
	const rootEmit = (event: Event) => {
		const withTaskId = { ...event, taskId: rootNodeId };
		emitEvent(ctx, project.id, withTaskId as Event);
	};

	// Create and attach TaskSession to root node
	const rootTaskSession: TaskSession = {
		queue,
		cwd: project.path,
		fallbackCwd: project.path,
		depth: 0,
		backgroundProcesses: new Map(),
		foregroundExecutions: new Map(),
	};
	rootNode.session = rootTaskSession;

	const session = agentCtx.provider.startSession({
		cwd: project.path,
		projectPath: project.path,
		emit: rootEmit,
		activeEvents: rootActiveEvents,
		systemPrompt,
		mcpToolDefs: agentCtx.mcpToolDefs,
		resumeSessionId,
		model: effectiveModel,
		queue,
		hasRunningChildren: agentCtx.hasRunningChildren,
		getSession,
	});

	// Register root queue in the unified globalAgentQueues registry
	globalAgentQueues.set(rootNodeId, queue);
	ctx.activeSessions.set(project.id, session);

	// Fire-and-forget: consume events in background
	(async () => {
		let caughtError = false;
		try {
			const finalResult = await consumeAgentEvents(session.events);

			// done() tool now updates status directly in the tracker.
			// If agent exited without calling done(), check current status.
			const rootAfterRun = tracker.get(rootNodeId);
			const wasStopped = ctx.activeSessions.get(project.id) !== session;
			if (
				!wasStopped &&
				(!rootAfterRun || rootAfterRun.status === "in_progress")
			) {
				// Agent exited on its own without calling done() — treat as success
				tracker.updateStatus(rootNodeId, "passed");
			}
			// If stopped externally (user Stop), leave status as-is (in_progress = will auto-resume)
			const currentRoot = tracker.get(rootNodeId);
			const didPass = currentRoot?.status === "passed" || finalResult.success;

			// Sum child costs from the tree (source of truth)
			const allNodes = tracker.allNodes();
			const childNodes = allNodes.filter(
				(n) => n.id !== rootNodeId && n.costUsd,
			);
			const childCostUsd = childNodes.reduce(
				(sum, n) => sum + (n.costUsd ?? 0),
				0,
			);
			const totalCostUsd = (finalResult.costUsd ?? 0) + childCostUsd;
			emitEvent(ctx, project.id, {
				type: "orchestration_completed",
				taskId: rootNodeId,
				success: didPass ?? true,
				costUsd: totalCostUsd,
				turns: finalResult.turns,
				inputTokens: finalResult.inputTokens,
				cacheCreationTokens: finalResult.cacheCreationTokens,
				cacheReadTokens: finalResult.cacheReadTokens,
				outputTokens: finalResult.outputTokens,
				childCosts: {
					totalCostUsd: childCostUsd,
					totalTurns: 0,
					taskCount: childNodes.length,
				},
				ts: Date.now(),
			});
			broadcastTreeUpdate(ctx, project.id, tracker);
		} catch (e) {
			caughtError = true;
			const message = e instanceof Error ? e.message : "Unknown error";
			tracker.updateStatus(rootNodeId, "failed");
			emitEvent(ctx, project.id, {
				type: "error",
				taskId: rootNodeId,
				message: `Agent failed: ${message}`,
				ts: Date.now(),
			});
		} finally {
			// Save tree state regardless of how the agent exited.
			try {
				await tracker.save();
			} catch {
				// Don't let save failure prevent cleanup
			}
			session.stop();
			// Remove root queue from unified registry
			globalAgentQueues.delete(rootNodeId);
			// Only clean up if this session is still the active one.
			// During restart, a new session replaces us — don't clobber it.
			if (ctx.activeSessions.get(project.id) === session) {
				ctx.activeSessions.delete(project.id);
				// On error, broadcast agent_stopped so the UI knows to clear
				// the running state. (Normal completions already broadcast
				// orchestration_completed which handles this.)
				if (caughtError) {
					emitEvent(ctx, project.id, {
						type: "agent_stopped",
						taskId: rootNodeId,
						ts: Date.now(),
					});
				}
			}
			// Clean up root session
			const rootNodeFinal = tracker.get(rootNodeId);
			if (rootNodeFinal?.session) {
				cleanupSessionBackgroundProcesses(
					rootNodeFinal.session.backgroundProcesses,
				);
				rootNodeFinal.session = undefined;
			}
			broadcastTreeUpdate(ctx, project.id, tracker);
			await mcpManager.disconnectAll();
		}
	})();
}

// --- Shared handlers (used by both REST routes and WS messages) ---

/** Start orchestration for a project. Used by POST /orchestrate/agent and WS orchestrate. */
export async function handleOrchestrate(
	ctx: DaemonContext,
	projectId: string,
	prompt: string,
	opts: { resume?: boolean; model?: string; childModel?: string },
	orchestratorSystemPrompt: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
	if (!ctx.startupReady) {
		return {
			ok: false,
			error: "Server starting up, please wait...",
			status: 503,
		};
	}
	const project = ctx.pm.get(projectId);
	if (!project) {
		return { ok: false, error: "Project not found", status: 404 };
	}
	if (ctx.restartingProjects.has(projectId)) {
		return {
			ok: false,
			error: "Agent restarting, please wait",
			status: 409,
		};
	}

	// Agent already running — enqueue the prompt as a user message instead of error
	const orchTracker = await getTracker(ctx, projectId);
	const orchRootNodeId = orchTracker.rootNodeId;
	if (orchRootNodeId) {
		const rootQueue = globalAgentQueues.get(orchRootNodeId);
		if (rootQueue) {
			const orchMsgId = ulid();
			// Write + broadcast message at send time (Phase 1)
			const orchUserMsg: Event = {
				type: "message",
				id: orchMsgId,
				taskId: orchRootNodeId,
				body: { source: "user", content: prompt },
				ts: Date.now(),
			};
			emitEvent(ctx, projectId, orchUserMsg);
			try {
				rootQueue.enqueue({
					source: "user",
					id: orchMsgId,
					content: prompt,
				});
			} catch {
				return { ok: false, error: "Queue closed", status: 409 };
			}
			return { ok: true };
		}
	}
	await getTracker(ctx, projectId);

	// Launch agent first (creates rootNodeId), then enqueue message
	await launchAgent(ctx, project, { ...opts }, orchestratorSystemPrompt);

	// Now enqueue the user message with header — provider is waiting for queue drain
	const orchRootId2 = orchTracker.rootNodeId;
	if (orchRootId2) {
		const orchMemory = readProjectMemory(project.path);
		const orchHeader = orchMemory
			? `Working directory: ${project.path}\n\n${orchMemory}`
			: `Working directory: ${project.path}`;
		const orchMsgId2 = ulid();

		emitEvent(ctx, projectId, {
			type: "message",
			id: orchMsgId2,
			taskId: orchRootId2,
			body: { source: "user", content: prompt, header: orchHeader },
			ts: Date.now(),
		});

		const orchRootQueue = globalAgentQueues.get(orchRootId2);
		if (orchRootQueue) {
			try {
				orchRootQueue.enqueue({
					source: "user",
					id: orchMsgId2,
					content: prompt,
					header: orchHeader,
				});
			} catch {
				// Queue may have closed
			}
		}
	}

	return { ok: true };
}

/**
 * Inject a user message into a running or stopped agent.
 * Thin wrapper around deliverMessage that adds REST-specific concerns:
 * - Project validation
 * - First-run launch (no rootNodeId yet)
 * - Auto-resume orchestrator when not running
 * - Pending message broadcast for UI feedback
 *
 * Used by POST /message and WS inject_message.
 */
export async function handleInjectMessage(
	ctx: DaemonContext,
	projectId: string,
	message: string,
	images?: QueueImage[],
	orchestratorSystemPrompt?: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
	const project = ctx.pm.get(projectId);
	if (!project) {
		return { ok: false, error: "Project not found", status: 404 };
	}

	const tracker = await getTracker(ctx, projectId);
	const rootNodeId = tracker.rootNodeId;

	if (!rootNodeId) {
		// No session at all — launch a brand new agent with this message as the prompt
		if (orchestratorSystemPrompt && !ctx.restartingProjects.has(projectId)) {
			// Build header with pre-loaded context (CLAUDE.md + memory.md)
			const memory = readProjectMemory(project.path);
			const header = memory
				? `Working directory: ${project.path}\n\n${memory}`
				: `Working directory: ${project.path}`;

			const freshMsgId = ulid();

			// Persist the user message to disk BEFORE launching — the provider
			// will drain it from the queue as its first message.
			// We need the rootNodeId, but it doesn't exist yet. Create it by
			// launching first, then persist.
			await launchAgent(ctx, project, {}, orchestratorSystemPrompt);

			const freshRootNodeId = tracker.rootNodeId;
			if (freshRootNodeId) {
				// Write + broadcast message at send time (Phase 1 of two-phase lifecycle)
				const userMsgEvent: Event = {
					type: "message",
					id: freshMsgId,
					taskId: freshRootNodeId,
					body: {
						source: "user",
						content: message,
						...(images?.length ? { images } : {}),
						header,
					},
					ts: Date.now(),
				};
				emitEvent(ctx, projectId, userMsgEvent);

				// Enqueue directly to the running agent's queue — it's waiting for first message
				const rootQueue = globalAgentQueues.get(freshRootNodeId);
				if (rootQueue) {
					try {
						rootQueue.enqueue({
							source: "user",
							id: freshMsgId,
							content: message,
							...(images?.length ? { images } : {}),
							header,
						});
					} catch {
						// Queue may have closed already
					}
				}
			}
			return { ok: true };
		}
		return {
			ok: false,
			error: "No active session for this project",
			status: 404,
		};
	}

	const msgId = ulid();
	const eventStore = getEventStore(ctx, projectId);

	// Check resume BEFORE writing message (the event we're about to write
	// shouldn't influence the fresh-vs-resume decision)
	const shouldResume = eventStore.has(rootNodeId);

	// Build header with fresh context for messages that will start/resume the agent.
	// Header is ALWAYS how context gets into the conversation — no special codepaths.
	const memory = readProjectMemory(project.path);
	const header = memory
		? `Working directory: ${project.path}\n\n${memory}`
		: `Working directory: ${project.path}`;

	// Write + broadcast message at send time (Phase 1 of two-phase lifecycle)
	// Frontend derives pending state from message events without matching messages_consumed.
	const userMsgEvent: Event = {
		type: "message",
		id: msgId,
		taskId: rootNodeId,
		body: {
			source: "user",
			content: message,
			...(images?.length ? { images } : {}),
			header,
		},
		ts: Date.now(),
	};
	emitEvent(ctx, projectId, userMsgEvent);

	// Unified delivery: enqueue if running, persist if not
	// Pass msgId through QueueMessage so providers can write messages_consumed
	const msg: QueueMessage = {
		source: "user",
		id: msgId,
		content: message,
		...(images?.length ? { images } : {}),
		header,
	};

	const result = await deliverMessage(ctx, project, rootNodeId, msg);

	if (result === "enqueued") {
		return { ok: true };
	}

	// Message was persisted (agent not running) — auto-resume if possible.
	// The message is already persisted to disk and will be delivered via queue drain.
	if (orchestratorSystemPrompt && !ctx.restartingProjects.has(projectId)) {
		await launchAgent(
			ctx,
			project,
			{ resume: shouldResume },
			orchestratorSystemPrompt,
		);
	}

	return { ok: true };
}

/** Answer a pending clarification. Used by POST /clarify and WS clarify_response. */
export async function handleClarifyResponse(
	ctx: DaemonContext,
	projectId: string,
	taskId: string,
	answer: string,
	clarificationId?: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
	// Route the response to the correct agent's queue via unified registry
	const targetQueue = globalAgentQueues.get(taskId);
	if (targetQueue) {
		try {
			targetQueue.enqueue({ source: "clarify_response", answer });
		} catch {
			return { ok: false, error: "Queue closed", status: 409 };
		}
		removePendingClarification(ctx, projectId, taskId, clarificationId);
		emitEvent(ctx, projectId, {
			type: "clarification_answered",
			taskId,
			answer,
			ts: Date.now(),
		});
		return { ok: true };
	}

	// No running agent — persist the clarify_response to disk
	const project = ctx.pm.get(projectId);
	if (!project) {
		return {
			ok: false,
			error: "No active session for this project",
			status: 404,
		};
	}

	await persistMessage(ctx.config.dataDir, projectId, taskId, {
		source: "clarify_response",
		answer,
	});
	removePendingClarification(ctx, projectId, taskId, clarificationId);
	emitEvent(ctx, projectId, {
		type: "clarification_answered",
		taskId,
		answer,
		ts: Date.now(),
	});
	return { ok: true };
}
