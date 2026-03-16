import { join } from "node:path";
import type {
	AgentEvent,
	AgentProvider,
	AgentRequest,
} from "../agent-provider.ts";
import {
	CostAccumulator,
	createOrchestratorTools,
	TASK_SYSTEM_PROMPT,
} from "../agent-tools.ts";
import { DEFAULT_MODEL } from "../config.ts";
import { McpClientManager } from "../mcp-client.ts";
import type { QueueImage } from "../message-queue.ts";
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
	addPendingMessage,
	broadcast,
	broadcastEvent,
	broadcastTreeUpdate,
	flushEvents,
	removePendingClarification,
} from "./event-system.ts";
import {
	getProjectProvider,
	getTracker,
	readProjectMemory,
	resolveProjectConfig,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Shared helpers — extracted from launchAgent / runChildAgentInBackground
// ---------------------------------------------------------------------------

/** Config + tools bundle produced by createAgentContext(). */
interface AgentContextResult {
	provider: ReturnType<typeof getProjectProvider>;
	effectiveCfg: Awaited<ReturnType<typeof resolveProjectConfig>>;
	costAccumulator: CostAccumulator;
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
	const costAccumulator = new CostAccumulator();

	const { toolDefs, hasRunningChildren } = createOrchestratorTools(
		{
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
			sessionsDir: join(ctx.config.dataDir, "sessions", project.id),
			dataDir: ctx.config.dataDir,
			onTaskEvent: (event) => {
				broadcastEvent(ctx, project.id, event);
				broadcastTreeUpdate(ctx, project.id, opts.tracker);
			},
			broadcastTreeUpdate: () =>
				broadcastTreeUpdate(ctx, project.id, opts.tracker),
		},
		costAccumulator,
	);

	const mcpToolDefs: Record<string, ToolDefinition[]> = {
		opengraft: toolDefs,
		...mcpManager.getToolDefs(),
	};

	return {
		provider,
		effectiveCfg,
		costAccumulator,
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
	/** Optional map of child queues (from agent-tools.ts closure). Updated on start/finish. */
	childQueues?: Map<string, MessageQueue>;
	/** Config for loading persisted messages from disk. Omit to skip. */
	persistedMessages?: {
		dataDir: string;
		projectId: string;
	};
}

/**
 * Shared child agent lifecycle: queue setup → stream events with done() detection → cleanup.
 *
 * Used by both:
 * - `executeChildStreaming` in agent-tools.ts (MCP send_message_to_child)
 * - `runChildAgentInBackground` in agent-lifecycle.ts (REST endpoints)
 *
 * The done() detection closes the child queue when `mcp__opengraft__done` tool_result
 * is observed and the tracker status is passed/failed, causing the provider run loop
 * to exit its yield mode.
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
		childQueues,
		persistedMessages,
	} = params;

	// Use pre-created queue or create a new one
	const childQueue = params.queue ?? new MessageQueue();
	if (childQueues) childQueues.set(taskId, childQueue);
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
			const { type: eventType, ...eventData } = result.value;
			onEvent(eventType, eventData as Record<string, unknown>);

			// When the child calls done(), its status is updated in the tracker
			// but the run loop enters yield mode (queue.wait()) instead of exiting.
			// Detect done() completion and close the queue so the run loop exits.
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
		return result.value;
	} finally {
		if (childQueues) childQueues.delete(taskId);
		globalAgentQueues.delete(taskId);
		childQueue.close();
	}
}

// ---------------------------------------------------------------------------

/**
 * Stop a running agent and clean up all associated state.
 * Single path for all stop operations (explicit stop, restart, project delete).
 *
 * @param opts.keepPendingMessages - Set true during restart so pending user messages
 *   survive for the new session to consume.
 */
export async function stopAgent(
	ctx: DaemonContext,
	projectId: string,
	opts?: { keepPendingMessages?: boolean },
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
					childQueue.close();
				}
				tracker.updateStatus(node.id, "failed");
			}
		}
		await tracker.save();
		broadcastTreeUpdate(ctx, projectId, tracker);
	}

	// Clear pending state
	if (!opts?.keepPendingMessages) {
		ctx.pendingMessages.delete(projectId);
		broadcast(ctx.wsClients, projectId, {
			type: "pending_messages",
			projectId,
			messages: [],
		});
	}
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
	});

	// Flush any pending events to disk to prevent data loss
	await flushEvents(ctx);
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
	prompt: string,
	model?: string,
): Promise<void> {
	const node = tracker.get(nodeId);
	if (!node) return;

	// Create worktree if the task doesn't have one yet
	if (!node.worktreePath) {
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);
		const slug = node.title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 30);
		const wt = await wm.create(node.id, slug);
		tracker.assignWorktree(node.id, wt.branch, wt.path);
	}

	tracker.updateStatus(nodeId, "in_progress");
	await tracker.save();
	broadcastTreeUpdate(ctx, project.id, tracker);

	await runChildAgentInBackground(ctx, project, tracker, nodeId, prompt, model);
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
		// Create the queue first — shared between MCP tools and runChildCore
		const childQueue = new MessageQueue();
		const agentCtx = await createAgentContext(ctx, project, {
			tracker,
			projectPath: node.worktreePath as string,
			currentTaskId: nodeId,
			depth: 1,
			queue: childQueue,
			mcpManager,
		});

		const sessionsDir = join(ctx.config.dataDir, "sessions", project.id);
		const agentResult = await runChildCore({
			provider: agentCtx.provider,
			tracker,
			taskId: nodeId,
			queue: childQueue,
			sessionRequest: {
				prompt,
				cwd: node.worktreePath as string,
				sessionsDir,
				systemPrompt: TASK_SYSTEM_PROMPT,
				resumeSessionId: nodeId,
				model: agentCtx.effectiveCfg.model,
				mcpToolDefs: agentCtx.mcpToolDefs,
				hasRunningChildren: agentCtx.hasRunningChildren,
			},
			onEvent: (eventType, eventData) => {
				if (eventType === "agent_idle" || eventType === "agent_active") {
					broadcastEvent(ctx, project.id, {
						type: eventType,
						taskId: nodeId,
					});
				} else {
					broadcastEvent(ctx, project.id, {
						type: "agent_event",
						taskId: nodeId,
						eventType,
						...eventData,
					});
				}
			},
			persistedMessages: {
				dataDir: ctx.config.dataDir,
				projectId: project.id,
			},
		});

		// done() tool now updates status directly in the tracker, so just use agentResult
		// for cost/output reporting. The task status is already set by the done() tool.
		const currentNode = tracker.get(nodeId);
		const didPass = currentNode?.status === "passed" || agentResult.success;
		if (!currentNode || currentNode.status === "in_progress") {
			// Agent exited without calling done() — treat as success
			tracker.updateStatus(nodeId, "passed");
		}
		await tracker.save();
		broadcastEvent(ctx, project.id, {
			type: "task_completed",
			taskId: nodeId,
			title: node.title,
			success: didPass,
			output: (agentResult.output ?? "").slice(0, 500),
		});
		broadcastTreeUpdate(ctx, project.id, tracker);
	} catch (e) {
		tracker.updateStatus(nodeId, "stuck");
		await tracker.save();
		broadcastEvent(ctx, project.id, {
			type: "error",
			taskId: nodeId,
			message: `Continue failed: ${e instanceof Error ? e.message : String(e)}`,
		});
		broadcastTreeUpdate(ctx, project.id, tracker);
	} finally {
		await flushEvents(ctx);
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
			? `${memory}\n\n---\n\n${opts.prompt}`
			: opts.prompt;

	const resumeSessionId = rootNodeId;

	// Append self-bootstrap mode instructions if enabled
	let systemPrompt = orchestratorSystemPrompt;
	if (agentCtx.effectiveCfg.selfBootstrap) {
		systemPrompt +=
			"\n\n## Self-Bootstrap Mode\nThis project is the tool's own codebase. The user may ask you to test features by interacting with the system in unconventional ways (e.g., testing resume on passed tasks, calling tools in unexpected sequences). When the user gives explicit instructions that conflict with your standard workflow, prioritize the user's instructions. You are modifying your own source code — be extra careful but also extra flexible.";
	}

	const session = agentCtx.provider.startSession({
		prompt,
		cwd: project.path,
		projectPath: project.path,
		sessionsDir: join(ctx.config.dataDir, "sessions", project.id),
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
					if (eventType === "agent_idle" || eventType === "agent_active") {
						broadcastEvent(ctx, project.id, {
							type: eventType,
							taskId: rootNodeId,
						});
					} else {
						broadcastEvent(ctx, project.id, {
							type: "agent_event",
							taskId: rootNodeId,
							eventType,
							...eventData,
						});
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

			const totalCostUsd =
				(finalResult.costUsd ?? 0) + agentCtx.costAccumulator.totalCostUsd;
			broadcastEvent(ctx, project.id, {
				type: "orchestration_completed",
				taskId: rootNodeId,
				success: didPass,
				costUsd: totalCostUsd,
				turns: finalResult.turns,
				inputTokens: finalResult.inputTokens,
				cacheCreationTokens: finalResult.cacheCreationTokens,
				cacheReadTokens: finalResult.cacheReadTokens,
				outputTokens: finalResult.outputTokens,
				childCosts: {
					totalCostUsd: agentCtx.costAccumulator.totalCostUsd,
					totalTurns: agentCtx.costAccumulator.totalTurns,
					taskCount: agentCtx.costAccumulator.taskCount,
				},
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
					});
				}
			}
			broadcastTreeUpdate(ctx, project.id, tracker);
			await flushEvents(ctx);
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
		addPendingMessage(ctx, projectId, null, prompt);
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

/** Inject a user message into a running agent. Used by POST /message and WS inject_message. */
export async function handleInjectMessage(
	ctx: DaemonContext,
	projectId: string,
	message: string,
	images?: QueueImage[],
	orchestratorSystemPrompt?: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
	const session = ctx.activeSessions.get(projectId);
	if (session) {
		try {
			const imgs = images?.length ? images : undefined;
			session.queue.enqueue({
				source: "user",
				content: message,
				images: imgs,
			});
		} catch {
			return { ok: false, error: "Queue closed", status: 409 };
		}
		addPendingMessage(ctx, projectId, null, message);
		return { ok: true };
	}

	// No active session — persist message to disk and auto-resume
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
			return { ok: true };
		}
		return {
			ok: false,
			error: "No active session for this project",
			status: 404,
		};
	}

	const msg = {
		source: "user" as const,
		content: message,
		...(images?.length ? { images } : {}),
	};
	await persistMessage(ctx.config.dataDir, projectId, rootNodeId, msg);
	addPendingMessage(ctx, projectId, null, message);

	// Auto-resume the orchestrator if we have the system prompt.
	// Don't pass the user message as prompt — it's already persisted in the queue
	// and will be delivered as a queue_message. Passing it as prompt would cause
	// the message to appear twice: once from orchestration_started and once from queue_message.
	if (orchestratorSystemPrompt && !ctx.restartingProjects.has(projectId)) {
		await launchAgent(
			ctx,
			project,
			{ prompt: "User sent a new message. Resuming.", resume: true },
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
	});
	return { ok: true };
}
