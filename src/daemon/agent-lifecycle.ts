import { join } from "node:path";
import type {
	AgentEvent,
	AgentProvider,
	AgentRequest,
} from "../agent-provider.ts";
import {
	buildTaskPrompt,
	createOrchestratorTools,
	slugify,
	TASK_SYSTEM_PROMPT,
} from "../agent-tools.ts";
import { DEFAULT_MODEL } from "../config.ts";
import type { BroadcastEvent } from "../events.ts";
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
import type { AgentResult } from "../types.ts";
import { WorktreeManager } from "../worktree-manager.ts";
import type { DaemonContext } from "./context.ts";
import {
	broadcast,
	broadcastEvent,
	broadcastPendingCleared,
	broadcastPendingFromQueue,
	broadcastTreeUpdate,
	removePendingClarification,
} from "./event-system.ts";
import {
	getEventStore,
	getProjectProvider,
	getSessionStore,
	getTracker,
	readProjectMemory,
	resolveProjectConfig,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Map provider AgentEvent → typed BroadcastEvent for WS emission
// ---------------------------------------------------------------------------

function agentEventToBroadcast(
	eventType: string,
	eventData: Record<string, unknown>,
	taskId: string,
): BroadcastEvent {
	const ts = Date.now();
	switch (eventType) {
		case "text_delta":
			return {
				type: "text_delta",
				content: (eventData.content as string) || "",
				taskId,
				ts,
			};
		case "text":
			return {
				type: "assistant_text",
				content: (eventData.content as string) || "",
				taskId,
				ts,
			};
		case "tool_use":
			return {
				type: "tool_call",
				tool: eventData.tool as string,
				toolUseId: eventData.toolUseId as string,
				input: eventData.input as Record<string, unknown>,
				taskId,
				ts,
			};
		case "tool_result":
			return {
				type: "tool_result",
				tool: eventData.tool as string,
				toolUseId: eventData.toolUseId as string,
				content: (eventData.content as string) || "",
				isError: (eventData.isError as boolean) || false,
				...(eventData.images
					? {
							images: eventData.images as Array<{
								base64: string;
								mediaType: string;
							}>,
						}
					: {}),
				taskId,
				ts,
			};
		case "error":
			return {
				type: "error",
				message: (eventData.message as string) || "",
				taskId,
				ts,
			};
		case "usage":
			return {
				type: "usage",
				taskId,
				inputTokens: eventData.inputTokens as number,
				contextWindow: eventData.contextWindow as number,
				estimated: (eventData.estimated as boolean) || undefined,
				ts,
			};
		case "compact_started":
			return { type: "compact_started", taskId, ts };
		case "compact":
			return {
				type: "compact_marker",
				checkpoint: eventData.checkpoint as string,
				savedTokens: eventData.savedTokens as number,
				taskId,
				ts,
			};
		case "queue_message":
			return {
				type: "queue_message",
				messages: (eventData.messages as string) || "",
				rawMessages: eventData.rawMessages as
					| Array<{
							source: string;
							content: string;
							images?: { base64: string; mediaType: string }[];
					  }>
					| undefined,
				taskId,
				ts,
			};
		case "status":
			return {
				type: "status",
				message: (eventData.message as string) || "",
				taskId,
				ts,
			};
		default:
			// Unknown event type — pass through as status
			return {
				type: "status",
				message: JSON.stringify({ eventType, ...eventData }),
				taskId,
				ts,
			};
	}
}

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
		/** Parent agent's queue for report_to_parent. Null/undefined for root orchestrator. */
		parentQueue?: MessageQueue;
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
		activeSessions: opts.depth === 0 ? ctx.activeSessions : undefined,
		currentProjectId: project.id,
		sessionStore: getSessionStore(ctx, project.id),
		dataDir: ctx.config.dataDir,
		onTaskEvent: (event) => {
			console.error(
				`[DEADLOCK-TRACE ${Date.now()}] onTaskEvent START`,
				event.type,
				event.taskId,
			);
			const ts = (event.ts as number) || Date.now();
			// Transform agent_event wrappers into flat BroadcastEvents
			if (event.type === "agent_event") {
				const taskId = (event.taskId as string) || "";
				const eventType = event.eventType as string;
				const { type: _t, taskId: _tid, eventType: _et, ...rest } = event;
				broadcastEvent(
					ctx,
					project.id,
					agentEventToBroadcast(
						eventType,
						rest as Record<string, unknown>,
						taskId,
					),
				);
			} else {
				// Already a valid BroadcastEvent shape — just ensure ts
				const withTs = event.ts ? event : { ...event, ts };
				broadcastEvent(ctx, project.id, withTs as unknown as BroadcastEvent);
			}
			console.error(`[DEADLOCK-TRACE ${Date.now()}] onTaskEvent broadcastEvent DONE`);
			broadcastTreeUpdate(ctx, project.id, opts.tracker);
			console.error(`[DEADLOCK-TRACE ${Date.now()}] onTaskEvent broadcastTreeUpdate DONE`);

			// Detect done() via task_completed event. done() emits this BEFORE
			// blocking on waitForQueueMessages(). Closing the queue here causes
			// waitForQueueMessages() to reject with "Queue closed", unblocking
			// the done() handler and allowing the provider stream to finish.
			// Without this, done()=yield deadlocks: tool_result never emits
			// because done() blocks, and nobody closes the queue.
			if (
				event.type === "task_completed" &&
				event.taskId === opts.currentTaskId &&
				opts.depth > 0
			) {
				const nodeStatus = opts.tracker.get(opts.currentTaskId)?.status;
				if (nodeStatus === "passed" || nodeStatus === "failed") {
					console.error(
						`[DEADLOCK-TRACE ${Date.now()}] onTaskEvent closing queue for done()`,
					);
					opts.queue.close();
					console.error(`[DEADLOCK-TRACE ${Date.now()}] onTaskEvent queue.close() DONE`);
				}
			}
		},
		parentQueue: opts.parentQueue,
		broadcastTreeUpdate: () =>
			broadcastTreeUpdate(ctx, project.id, opts.tracker),
		launchChild: async (nodeId: string, prompt: string) => {
			await runChildAgentInBackground(
				ctx,
				project,
				opts.tracker,
				nodeId,
				prompt,
			);
		},
		deliverMessage: async (nodeId: string, message: QueueMessage) => {
			await deliverMessage(ctx, project, nodeId, message);
		},
	});

	const mcpToolDefs: Record<string, ToolDefinition[]> = {
		opengraft: toolDefs,
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
 * Consume all events from a session's async generator, broadcasting each one.
 * Returns the final AgentResult when the generator is done.
 */
async function consumeAgentEvents(
	events: AsyncGenerator<AgentEvent, AgentResult>,
	onEvent: (eventType: string, eventData: Record<string, unknown>) => void,
): Promise<AgentResult> {
	let result = await events.next();
	while (!result.done) {
		const { type: eventType, ...eventData } = result.value;
		onEvent(eventType, eventData as Record<string, unknown>);
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
	/** Event callback — called for each agent event. */
	onEvent: (eventType: string, eventData: Record<string, unknown>) => void;
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
 * Done detection has two paths:
 * 1. Primary: onTaskEvent callback detects task_completed and closes queue BEFORE
 *    done()'s waitForQueueMessages() blocks (prevents deadlock).
 * 2. Fallback: tool_result with tool === "mcp__opengraft__done" closes queue
 *    (handles edge cases where done() returns without blocking).
 */
export async function runChildCore(
	params: RunChildCoreParams,
): Promise<AgentResult> {
	const {
		provider,
		tracker,
		taskId,
		sessionRequest,
		onEvent,
		persistedMessages,
	} = params;

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
		console.error(`[DEADLOCK-TRACE ${Date.now()}] runChildCore stream START taskId=${taskId}`);
		const stream = provider.stream(sessionRequest);
		let result = await stream.next();
		while (!result.done) {
			const { type: eventType, ...eventData } = result.value;
			onEvent(eventType, eventData as Record<string, unknown>);

			// Fallback done() detection via tool_result. The primary detection path
			// is in onTaskEvent (task_completed event closes the queue before
			// waitForQueueMessages blocks). This fallback handles edge cases where
			// done() completes without blocking (e.g., no queue available).
			if (
				eventType === "tool_result" &&
				"tool" in eventData &&
				eventData.tool === "mcp__opengraft__done"
			) {
				const nodeStatus = tracker.get(taskId)?.status;
				if (nodeStatus === "passed" || nodeStatus === "failed") {
					childQueue.close();
					// Drain remaining events until the generator exits
					result = await stream.next();
					while (!result.done) {
						const { type: et, ...ed } = result.value;
						onEvent(et, ed as Record<string, unknown>);
						result = await stream.next();
					}
					return result.value;
				}
			}

			result = await stream.next();
		}
		console.error(`[DEADLOCK-TRACE ${Date.now()}] runChildCore stream DONE taskId=${taskId}`);
		return result.value;
	} finally {
		console.error(`[DEADLOCK-TRACE ${Date.now()}] runChildCore finally cleanup taskId=${taskId}`);
		globalAgentQueues.delete(taskId);
		childQueue.close();
	}
}

// ---------------------------------------------------------------------------

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

	// Cascade stop to all in-progress child agents
	if (tracker) {
		const rootNodeId = tracker.rootNodeId;
		for (const node of tracker.allNodes()) {
			if (node.status === "in_progress" && node.id !== rootNodeId) {
				const childQueue = globalAgentQueues.get(node.id);
				if (childQueue) {
					globalAgentQueues.delete(node.id);
					childQueue.close();
				}
				tracker.updateStatus(node.id, "failed");
			}
		}
		await tracker.save();
		broadcastTreeUpdate(ctx, projectId, tracker);
	}

	// Clear pending state — queue is gone, no pending messages
	broadcastPendingCleared(ctx, projectId);
	ctx.pendingClarifications.delete(projectId);
	broadcast(ctx.wsClients, projectId, {
		type: "pending_clarifications",
		projectId,
		clarifications: [],
	});

	const rootNodeId = tracker?.rootNodeId;
	broadcastEvent(ctx, projectId, {
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

	// 1. Try direct queue delivery (child agent running)
	const queue = globalAgentQueues.get(nodeId);
	if (queue) {
		try {
			console.error(`[DEADLOCK-TRACE ${Date.now()}] deliverMessage enqueue START`, nodeId);
			queue.enqueue(message);
			console.error(`[DEADLOCK-TRACE ${Date.now()}] deliverMessage enqueue DONE`, nodeId);
			// onEnqueue callback handles pending broadcast (set at queue creation)
			return "enqueued";
		} catch {
			// Queue was closed — fall through to persist + launch
		}
	}

	// 2. Check activeSessions for root orchestrator
	const rootNodeId = tracker.rootNodeId;
	if (rootNodeId === nodeId) {
		const rootSession = ctx.activeSessions.get(project.id);
		if (rootSession?.queue) {
			try {
				console.error(`[DEADLOCK-TRACE ${Date.now()}] deliverMessage enqueue START`, nodeId);
				rootSession.queue.enqueue(message);
				console.error(`[DEADLOCK-TRACE ${Date.now()}] deliverMessage enqueue DONE`, nodeId);
				// onEnqueue callback handles pending broadcast (set at queue creation)
				return "enqueued";
			} catch {
				// Queue was closed — fall through to persist + launch
			}
		}
	}

	// 3. No running agent — persist to disk
	await persistMessage(ctx.config.dataDir, project.id, nodeId, message);

	// 4. Auto-launch for child nodes only. Root launch requires caller-specific
	// logic (orchestratorSystemPrompt, resume detection) — caller handles it.
	const node = tracker.get(nodeId);
	if (node?.parentId) {
		ensureChildAgentRunning(ctx, project, tracker, nodeId).catch((e) => {
			broadcastEvent(ctx, project.id, {
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

	broadcastEvent(ctx, project.id, {
		type: "task_started",
		taskId: nodeId,
		title: node.title,
		ts: Date.now(),
	});
	broadcastTreeUpdate(ctx, project.id, tracker);

	// Build a generic prompt — the real user/parent message is persisted to disk
	// and will be delivered via queue drain (runChildCore loads persisted messages).
	const hasExistingSession =
		node.status === "failed" ||
		node.status === "stuck" ||
		node.status === "passed" ||
		node.status === "closed";
	let genericPrompt: string;
	if (hasExistingSession) {
		genericPrompt = "New message received. Resume and check your queue.";
	} else {
		const memory = readProjectMemory(node.worktreePath ?? project.path, false);
		genericPrompt = buildTaskPrompt(node, tracker, memory);
	}

	await runChildAgentInBackground(
		ctx,
		project,
		tracker,
		nodeId,
		genericPrompt,
		model,
	);
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
function findParentQueue(
	ctx: DaemonContext,
	projectId: string,
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

		// Root orchestrator check — its queue is in activeSessions, not globalAgentQueues
		if (!ancestor.parentId) {
			const rootQueue = ctx.activeSessions.get(projectId)?.queue;
			if (rootQueue) return { queue: rootQueue, targetId };
			break;
		}

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
	prompt: string,
	_model?: string,
): Promise<void> {
	const node = tracker.get(nodeId);
	if (!node?.worktreePath) return;

	const mcpManager = new McpClientManager();
	try {
		// Compute depth from the tree and find the parent's queue
		const depth = computeDepth(tracker, nodeId);
		const parentQueueResult = findParentQueue(ctx, project.id, tracker, nodeId);

		// Create the queue first — shared between MCP tools and runChildCore
		const childQueue = new MessageQueue();
		childQueue.onEnqueue = (msg) =>
			broadcastPendingFromQueue(ctx, project.id, [msg]);
		childQueue.onDrain = () => broadcastPendingCleared(ctx, project.id);
		const agentCtx = await createAgentContext(ctx, project, {
			tracker,
			projectPath: node.worktreePath as string,
			currentTaskId: nodeId,
			depth,
			queue: childQueue,
			parentQueue: parentQueueResult?.queue,
			mcpManager,
		});

		const agentResult = await runChildCore({
			provider: agentCtx.provider,
			tracker,
			taskId: nodeId,
			queue: childQueue,
			sessionRequest: {
				prompt,
				cwd: node.worktreePath as string,
				sessionStore: getSessionStore(ctx, project.id),
				eventStore: getEventStore(ctx, project.id),
				systemPrompt: TASK_SYSTEM_PROMPT,
				resumeSessionId: nodeId,
				model: agentCtx.effectiveCfg.model,
				mcpToolDefs: agentCtx.mcpToolDefs,
				hasRunningChildren: agentCtx.hasRunningChildren,
			},
			onEvent: (eventType, eventData) => {
				if (eventType === "agent_idle") {
					broadcastEvent(ctx, project.id, {
						type: "agent_idle",
						taskId: nodeId,
						ts: Date.now(),
					});
				} else if (eventType === "agent_active") {
					broadcastEvent(ctx, project.id, {
						type: "agent_active",
						taskId: nodeId,
						ts: Date.now(),
					});
				} else {
					broadcastEvent(
						ctx,
						project.id,
						agentEventToBroadcast(eventType, eventData, nodeId),
					);
				}
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
			broadcastEvent(ctx, project.id, {
				type: "budget_exceeded",
				taskId: nodeId,
				title: node.title,
				costUsd: updatedNode.costUsd,
				budgetUsd: updatedNode.budgetUsd,
				ts: Date.now(),
			});
		}

		// done() tool updates status directly in the tracker AND emits task_completed.
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

		// Only emit task_completed if done() wasn't called (it already emitted)
		if (!doneWasCalled) {
			broadcastEvent(ctx, project.id, {
				type: "task_completed",
				taskId: nodeId,
				title: node.title,
				success: success ?? true,
				output: (agentResult.output ?? "").slice(0, 500),
				ts: Date.now(),
			});
		}

		// Enqueue child_complete message to parent's queue (bubbles up through non-running intermediates)
		const completionResult = findParentQueue(ctx, project.id, tracker, nodeId);
		const completionNotification = {
			source: "child_complete" as const,
			taskId: nodeId,
			title: node.title,
			success: success ?? true,
			output: (agentResult.output ?? "").slice(0, 2000),
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
			(!completionResult?.queue || completionResult.targetId !== node.parentId)
		) {
			await persistMessage(
				ctx.config.dataDir,
				project.id,
				node.parentId,
				completionNotification,
			);
		}

		broadcastTreeUpdate(ctx, project.id, tracker);
	} catch (e) {
		tracker.updateStatus(nodeId, "stuck");
		await tracker.save();
		const errorMsg = e instanceof Error ? e.message : String(e);
		broadcastEvent(ctx, project.id, {
			type: "task_completed",
			taskId: nodeId,
			title: node.title,
			success: false,
			error: errorMsg,
			output: `Error: ${errorMsg}`,
			ts: Date.now(),
		});

		// Enqueue child_complete (failure) to parent's queue (bubbles up through non-running intermediates)
		const errorResult = findParentQueue(ctx, project.id, tracker, nodeId);
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
		prompt: string;
		resume?: boolean;
		model?: string;
		childModel?: string;
	},
	orchestratorSystemPrompt: string,
) {
	const tracker = ctx.trackers.get(project.id);
	if (!tracker) return;

	// Ensure root node exists for the orchestrator
	const rootNode = tracker.ensureRootNode("Orchestrator", opts.prompt);
	const rootNodeId = rootNode.id;
	tracker.updateStatus(rootNodeId, "in_progress");
	tracker.save().catch(() => {});

	const queue = new MessageQueue();

	// Wire up enqueue/drain callbacks for pending message indicators
	queue.onEnqueue = (msg) => broadcastPendingFromQueue(ctx, project.id, [msg]);
	queue.onDrain = () => broadcastPendingCleared(ctx, project.id);

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

	const agentCtx = await createAgentContext(ctx, project, {
		tracker,
		projectPath: project.path,
		currentTaskId: rootNodeId,
		depth: 0,
		childModel: opts.childModel,
		queue,
		mcpManager,
	});

	// Priority: API param > resolved config
	const effectiveModel = opts.model ?? agentCtx.effectiveCfg.model;

	broadcastEvent(ctx, project.id, {
		type: "orchestration_started",
		taskId: rootNodeId,
		resume: opts.resume ?? false,
		// Don't include prompt when resuming — the user message is already in the
		// queue and will appear as a queue_message event. Including it here would
		// cause the message to display twice in the UI.
		prompt: opts.resume ? undefined : opts.prompt,
		provider: agentCtx.provider.name,
		model: effectiveModel ?? DEFAULT_MODEL,
		ts: Date.now(),
	});
	broadcastTreeUpdate(ctx, project.id, tracker);

	// sessionId = taskId: orchestrator's session is always its rootNodeId.
	// The provider loads the session file if it exists.
	const shouldResume = opts.resume;

	const memory = readProjectMemory(project.path);
	const prompt = shouldResume
		? (opts.prompt ??
			"Continue where you left off. Check the task tree and proceed.")
		: memory
			? `${memory}\n\n${opts.prompt}`
			: opts.prompt;

	const resumeSessionId = rootNodeId;

	// Append self-bootstrap mode instructions if enabled
	let systemPrompt = orchestratorSystemPrompt;
	if (agentCtx.effectiveCfg.selfBootstrap) {
		systemPrompt +=
			"\n\n## Self-Bootstrap Mode\nThis project is the tool's own codebase. The user may ask you to test features by interacting with the system in unconventional ways (e.g., testing resume on passed tasks, calling tools in unexpected sequences). When the user gives explicit instructions that conflict with your standard workflow, prioritize the user's instructions. You are modifying your own source code — be extra careful but also extra flexible.\n\nWhen running in self-bootstrap mode, bugs you introduced may break features you depend on. The system may not behave as documented — your own changes may have altered its behavior in ways you can't observe from inside. The user can see the actual system state via the UI. When they give you instructions that seem redundant, illogical, or contradictory to how the system should work, follow them immediately — they're guiding you through a workaround for a bug in your own code. Don't argue or explain how it should work; just do what they say. The workarounds are temporary until the fix is merged and the daemon restarts with new code.";
	}

	const session = agentCtx.provider.startSession({
		prompt,
		cwd: project.path,
		projectPath: project.path,
		sessionStore: getSessionStore(ctx, project.id),
		eventStore: getEventStore(ctx, project.id),
		systemPrompt,
		mcpToolDefs: agentCtx.mcpToolDefs,
		resumeSessionId,
		model: effectiveModel,
		queue,
		hasRunningChildren: agentCtx.hasRunningChildren,
	});

	ctx.activeSessions.set(project.id, session);

	// Fire-and-forget: consume events in background
	(async () => {
		let caughtError = false;
		try {
			const finalResult = await consumeAgentEvents(
				session.events,
				(eventType, eventData) => {
					if (eventType === "agent_idle") {
						broadcastEvent(ctx, project.id, {
							type: "agent_idle",
							taskId: rootNodeId,
							ts: Date.now(),
						});
					} else if (eventType === "agent_active") {
						broadcastEvent(ctx, project.id, {
							type: "agent_active",
							taskId: rootNodeId,
							ts: Date.now(),
						});
					} else {
						broadcastEvent(
							ctx,
							project.id,
							agentEventToBroadcast(eventType, eventData, rootNodeId),
						);
					}
				},
			);

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
			broadcastEvent(ctx, project.id, {
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
			broadcastEvent(ctx, project.id, {
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
			// Only clean up if this session is still the active one.
			// During restart, a new session replaces us — don't clobber it.
			if (ctx.activeSessions.get(project.id) === session) {
				ctx.activeSessions.delete(project.id);
				// On error, broadcast agent_stopped so the UI knows to clear
				// the running state. (Normal completions already broadcast
				// orchestration_completed which handles this.)
				if (caughtError) {
					broadcastEvent(ctx, project.id, {
						type: "agent_stopped",
						taskId: rootNodeId,
						ts: Date.now(),
					});
				}
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
	const existingSession = ctx.activeSessions.get(projectId);
	if (existingSession) {
		try {
			existingSession.queue.enqueue({ source: "user", content: prompt });
		} catch {
			return { ok: false, error: "Queue closed", status: 409 };
		}
		// onEnqueue callback handles pending broadcast
		return { ok: true };
	}
	await getTracker(ctx, projectId);
	await launchAgent(
		ctx,
		project,
		{ prompt, ...opts },
		orchestratorSystemPrompt,
	);
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
			await launchAgent(
				ctx,
				project,
				{ prompt: message },
				orchestratorSystemPrompt,
			);
			broadcastEvent(ctx, projectId, {
				type: "message_injected",
				message,
				ts: Date.now(),
			});
			return { ok: true };
		}
		return {
			ok: false,
			error: "No active session for this project",
			status: 404,
		};
	}

	// Unified delivery: enqueue if running, persist if not
	const msg: QueueMessage = {
		source: "user",
		content: message,
		...(images?.length ? { images } : {}),
	};

	const result = await deliverMessage(ctx, project, rootNodeId, msg);

	if (result === "enqueued") {
		// deliverMessage already broadcast pending state from queue
		broadcastEvent(ctx, projectId, {
			type: "message_injected",
			message,
			ts: Date.now(),
		});
		return { ok: true };
	}

	// Message was persisted — broadcast as pending until agent loads it
	broadcast(ctx.wsClients, projectId, {
		type: "pending_messages",
		projectId,
		messages: [{ text: message, timestamp: Date.now() }],
	});

	// Message was persisted (agent not running) — auto-resume if possible.
	// Don't pass the user message as prompt — it's already persisted to disk
	// and will be delivered as a queue_message. Passing it as prompt would cause
	// the message to appear twice.
	if (orchestratorSystemPrompt && !ctx.restartingProjects.has(projectId)) {
		const store = getSessionStore(ctx, projectId);
		const shouldResume = store.hasAny(rootNodeId);
		if (shouldResume) {
			await launchAgent(
				ctx,
				project,
				{ prompt: "User sent a new message. Resuming.", resume: true },
				orchestratorSystemPrompt,
			);
		} else {
			// No session history — clear persisted messages and start fresh
			await clearPersistedMessages(ctx.config.dataDir, projectId, rootNodeId);
			await launchAgent(
				ctx,
				project,
				{ prompt: message },
				orchestratorSystemPrompt,
			);
		}
	}

	broadcastEvent(ctx, projectId, {
		type: "message_injected",
		message,
		ts: Date.now(),
	});
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
	const session = ctx.activeSessions.get(projectId);
	if (session) {
		// Route the response to the correct agent's queue:
		// - If taskId has a queue in globalAgentQueues, it's a child agent → route there
		// - Otherwise, fall back to session.queue (the orchestrator)
		const targetQueue = globalAgentQueues.get(taskId) ?? session.queue;
		try {
			targetQueue.enqueue({ source: "clarify_response", answer });
		} catch {
			return { ok: false, error: "Queue closed", status: 409 };
		}
		removePendingClarification(ctx, projectId, taskId, clarificationId);
		broadcastEvent(ctx, projectId, {
			type: "clarification_answered",
			taskId,
			answer,
			ts: Date.now(),
		});
		return { ok: true };
	}

	// No active session — persist the clarify_response to disk
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
	broadcastEvent(ctx, projectId, {
		type: "clarification_answered",
		taskId,
		answer,
		ts: Date.now(),
	});
	return { ok: true };
}
