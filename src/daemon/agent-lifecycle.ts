import { join } from "node:path";
import type { AgentEvent } from "../agent-provider.ts";
import {
	CostAccumulator,
	createOrchestratorTools,
	TASK_SYSTEM_PROMPT,
} from "../agent-tools.ts";
import { DEFAULT_MODEL } from "../config.ts";
import { McpClientManager } from "../mcp-client.ts";
import type { QueueImage } from "../message-queue.ts";
import { globalAgentQueues, MessageQueue } from "../message-queue.ts";
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
		doneRef: { done: null | { status: "passed" | "failed"; summary: string } };
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
			doneRef: opts.doneRef,
			defaultBudgetUsd: effectiveCfg.budgetUsd,
			clarifyTimeoutMs: effectiveCfg.clarifyTimeoutMs,
			maxDepth: effectiveCfg.maxDepth,
			projectManager: opts.depth === 0 ? ctx.pm : undefined,
			activeSessions: opts.depth === 0 ? ctx.activeSessions : undefined,
			currentProjectId: project.id,
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

/**
 * Stop a running agent and clean up all associated state.
 * Single path for all stop operations (explicit stop, restart, project delete).
 *
 * @param opts.clearAutoResume - Set true for explicit stops (user stop, project delete).
 *   Leave false for restart (autoResume should persist).
 * @param opts.keepPendingMessages - Set true during restart so pending user messages
 *   survive for the new session to consume.
 */
export async function stopAgent(
	ctx: DaemonContext,
	projectId: string,
	opts?: { clearAutoResume?: boolean; keepPendingMessages?: boolean },
): Promise<void> {
	const session = ctx.activeSessions.get(projectId);
	if (!session) return;

	const tracker = ctx.trackers.get(projectId);
	if (tracker && opts?.clearAutoResume) {
		tracker.autoResume = false;
		await tracker.save();
	}

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
	const childQueue = new MessageQueue();
	globalAgentQueues.set(nodeId, childQueue);
	const mcpManager = new McpClientManager();
	const doneRef: {
		done: null | { status: "passed" | "failed"; summary: string };
	} = { done: null };
	try {
		const agentCtx = await createAgentContext(ctx, project, {
			tracker,
			projectPath: node.worktreePath as string,
			currentTaskId: nodeId,
			depth: 1,
			queue: childQueue,
			doneRef,
			mcpManager,
		});

		const sessionsDir = join(ctx.config.dataDir, "sessions", project.id);
		const session = agentCtx.provider.startSession({
			prompt,
			cwd: node.worktreePath as string,
			sessionsDir,
			systemPrompt: TASK_SYSTEM_PROMPT,
			resumeSessionId: nodeId,
			model: agentCtx.effectiveCfg.model,
			mcpToolDefs: agentCtx.mcpToolDefs,
			queue: childQueue,
			doneRef,
			hasRunningChildren: agentCtx.hasRunningChildren,
		});

		const agentResult = await consumeAgentEvents(
			session.events,
			(eventType, eventData) => {
				broadcastEvent(ctx, project.id, {
					type: "agent_event",
					taskId: nodeId,
					eventType,
					...eventData,
				});
			},
		);

		// Use doneRef if available; fall back to agentResult.success
		const didPass = doneRef.done
			? doneRef.done.status === "passed"
			: agentResult.success;
		const newStatus = didPass ? "passed" : "failed";
		tracker.updateStatus(nodeId, newStatus);
		await tracker.save();
		broadcastEvent(ctx, project.id, {
			type: "task_completed",
			taskId: nodeId,
			title: node.title,
			success: didPass,
			output: (doneRef.done?.summary ?? agentResult.output ?? "").slice(0, 500),
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
		globalAgentQueues.delete(nodeId);
		childQueue.close();
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

	// Mark project for auto-resume on daemon restart
	tracker.autoResume = true;
	tracker.save().catch(() => {});

	const queue = new MessageQueue();
	const doneRef: {
		done: null | { status: "passed" | "failed"; summary: string };
	} = { done: null };
	const mcpManager = new McpClientManager();

	const agentCtx = await createAgentContext(ctx, project, {
		tracker,
		projectPath: project.path,
		currentTaskId: rootNodeId,
		depth: 0,
		childModel: opts.childModel,
		queue,
		doneRef,
		mcpManager,
	});

	// Priority: API param > resolved config
	const effectiveModel = opts.model ?? agentCtx.effectiveCfg.model;

	broadcastEvent(ctx, project.id, {
		type: "orchestration_started",
		taskId: rootNodeId,
		prompt: opts.prompt,
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
		doneRef,
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
					broadcastEvent(ctx, project.id, {
						type: "agent_event",
						taskId: rootNodeId,
						eventType,
						...eventData,
					});
				},
			);

			// Update root node status based on result
			const didPass = doneRef.done
				? doneRef.done.status === "passed"
				: finalResult.success;
			tracker.updateStatus(rootNodeId, didPass ? "passed" : "failed");

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

			// Clear auto-resume on normal completion (not during restart)
			if (ctx.activeSessions.get(project.id) === session) {
				tracker.autoResume = false;
			}
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
	if (
		ctx.activeSessions.has(projectId) ||
		ctx.restartingProjects.has(projectId)
	) {
		return {
			ok: false,
			error: "Agent already running for this project",
			status: 409,
		};
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
export function handleInjectMessage(
	ctx: DaemonContext,
	projectId: string,
	message: string,
	images?: QueueImage[],
): { ok: boolean; error?: string; status?: number } {
	const session = ctx.activeSessions.get(projectId);
	if (!session) {
		return {
			ok: false,
			error: "No active session for this project",
			status: 404,
		};
	}
	try {
		const imgs = images?.length ? images : undefined;
		session.queue.enqueue({ source: "user", content: message, images: imgs });
	} catch {
		return { ok: false, error: "Queue closed", status: 409 };
	}
	addPendingMessage(ctx, projectId, null, message);
	return { ok: true };
}

/** Answer a pending clarification. Used by POST /clarify and WS clarify_response. */
export function handleClarifyResponse(
	ctx: DaemonContext,
	projectId: string,
	taskId: string,
	answer: string,
	clarificationId?: string,
): { ok: boolean; error?: string; status?: number } {
	const session = ctx.activeSessions.get(projectId);
	if (!session) {
		return {
			ok: false,
			error: "No active session for this project",
			status: 404,
		};
	}
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
