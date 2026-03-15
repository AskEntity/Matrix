import { join } from "node:path";
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
import { WorktreeManager } from "../worktree-manager.ts";
import type { DaemonContext } from "./context.ts";
import {
	addPendingMessage,
	broadcast,
	broadcastEvent,
	broadcastTreeUpdate,
	removePendingClarification,
} from "./event-system.ts";
import {
	getProjectProvider,
	getTracker,
	readProjectMemory,
	resolveProjectConfig,
} from "./helpers.ts";

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

	// Save session for future resume
	const tracker = ctx.trackers.get(projectId);
	if (tracker && session.sessionId) {
		tracker.orchestratorSessionId = session.sessionId;
		if (opts?.clearAutoResume) {
			tracker.autoResume = false;
		}
		await tracker.save();
	}

	session.stop();
	ctx.activeSessions.delete(projectId);

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
	try {
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);
		const costAccumulator = new CostAccumulator();
		const doneRef: {
			done: null | { status: "passed" | "failed"; summary: string };
		} = { done: null };
		const effectiveCfg = await resolveProjectConfig(
			ctx,
			project.path,
			project.id,
		);
		const provider = getProjectProvider(ctx, effectiveCfg);

		// Connect to external MCP servers if configured
		if (
			effectiveCfg.mcpServers &&
			Object.keys(effectiveCfg.mcpServers).length > 0
		) {
			await mcpManager.connectAll(effectiveCfg.mcpServers);
		}

		const { toolDefs, hasRunningChildren } = createOrchestratorTools(
			{
				tracker,
				provider,
				worktrees: wm,
				projectPath: node.worktreePath as string,
				repoPath: project.path,
				currentTaskId: nodeId,
				depth: 1,
				queue: childQueue,
				doneRef,
				defaultBudgetUsd: effectiveCfg.budgetUsd,
				clarifyTimeoutMs: effectiveCfg.clarifyTimeoutMs,
				maxDepth: effectiveCfg.maxDepth,
				onTaskEvent: (event) => {
					broadcastEvent(ctx, project.id, event);
					broadcastTreeUpdate(ctx, project.id, tracker);
				},
				broadcastTreeUpdate: () =>
					broadcastTreeUpdate(ctx, project.id, tracker),
			},
			costAccumulator,
		);

		// Merge opengraft tools with external MCP server tools
		const mcpToolDefs: Record<string, ToolDefinition[]> = {
			opengraft: toolDefs,
			...mcpManager.getToolDefs(),
		};

		const session = provider.startSession({
			prompt,
			cwd: node.worktreePath as string,
			systemPrompt: TASK_SYSTEM_PROMPT,
			resumeSessionId: node.sessionId ?? undefined,
			model: effectiveCfg.model,
			mcpToolDefs,
			queue: childQueue,
			doneRef,
			hasRunningChildren,
		});

		let result = await session.events.next();
		while (!result.done) {
			const { type: eventType, ...eventData } = result.value;
			broadcastEvent(ctx, project.id, {
				type: "agent_event",
				taskId: nodeId,
				eventType,
				...eventData,
			});
			result = await session.events.next();
		}
		const agentResult = result.value;

		if (agentResult.sessionId) {
			tracker.assignSession(nodeId, agentResult.sessionId);
		}
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

	// Resolve effective config: global + repo + local
	const effectiveCfg = await resolveProjectConfig(
		ctx,
		project.path,
		project.id,
	);
	const provider = getProjectProvider(ctx, effectiveCfg);

	// Priority: API param > resolved config
	const effectiveModel = opts.model ?? effectiveCfg.model;
	const effectiveChildModel = opts.childModel ?? effectiveCfg.childModel;

	// Ensure root node exists for the orchestrator
	const rootNode = tracker.ensureRootNode("Orchestrator", opts.prompt);
	const rootNodeId = rootNode.id;
	tracker.updateStatus(rootNodeId, "in_progress");

	// Mark project for auto-resume on daemon restart
	tracker.autoResume = true;
	tracker.save().catch(() => {});

	broadcastEvent(ctx, project.id, {
		type: "orchestration_started",
		taskId: rootNodeId,
		prompt: opts.prompt,
		provider: provider.name,
		model: effectiveModel ?? DEFAULT_MODEL,
	});
	broadcastTreeUpdate(ctx, project.id, tracker);

	const wtRoot = join(project.path, ".worktrees");
	const wm = new WorktreeManager(project.path, wtRoot);
	const costAccumulator = new CostAccumulator();
	const queue = new MessageQueue();
	const doneRef: {
		done: null | { status: "passed" | "failed"; summary: string };
	} = { done: null };
	const mcpManager = new McpClientManager();

	// Connect to external MCP servers if configured
	if (
		effectiveCfg.mcpServers &&
		Object.keys(effectiveCfg.mcpServers).length > 0
	) {
		await mcpManager.connectAll(effectiveCfg.mcpServers);
	}

	const { toolDefs, hasRunningChildren } = createOrchestratorTools(
		{
			tracker,
			provider,
			worktrees: wm,
			projectPath: project.path,
			repoPath: project.path,
			currentTaskId: rootNodeId,
			depth: 0,
			childModel: effectiveChildModel,
			queue,
			doneRef,
			defaultBudgetUsd: effectiveCfg.budgetUsd,
			clarifyTimeoutMs: effectiveCfg.clarifyTimeoutMs,
			maxDepth: effectiveCfg.maxDepth,
			onTaskEvent: (event) => {
				broadcastEvent(ctx, project.id, event);
				broadcastTreeUpdate(ctx, project.id, tracker);
			},
			broadcastTreeUpdate: () => broadcastTreeUpdate(ctx, project.id, tracker),
		},
		costAccumulator,
	);

	// Merge opengraft tools with external MCP server tools
	const mcpToolDefs: Record<string, ToolDefinition[]> = {
		opengraft: toolDefs,
		...mcpManager.getToolDefs(),
	};

	// Auto-resume: if we have a previous session, always resume it
	const hasSession = Boolean(tracker.orchestratorSessionId);
	const shouldResume = opts.resume || hasSession;

	const memory = readProjectMemory(project.path);
	const prompt = shouldResume
		? (opts.prompt ??
			"Continue where you left off. Check the task tree and proceed.")
		: memory
			? `${memory}\n\n---\n\n${opts.prompt}`
			: opts.prompt;

	const resumeSessionId = shouldResume
		? (tracker.orchestratorSessionId ?? undefined)
		: undefined;

	// Use startSession for message injection support
	const session = provider.startSession({
		prompt,
		cwd: project.path,
		projectPath: project.path,
		sessionsDir: join(ctx.config.dataDir, "sessions", project.id),
		systemPrompt: orchestratorSystemPrompt,
		mcpToolDefs,
		resumeSessionId,
		model: effectiveModel,
		queue,
		doneRef,
		hasRunningChildren,
	});

	ctx.activeSessions.set(project.id, session);

	// Fire-and-forget: consume events in background
	(async () => {
		let caughtError = false;
		try {
			let result = await session.events.next();
			while (!result.done) {
				const { type: eventType, ...eventData } = result.value;
				broadcastEvent(ctx, project.id, {
					type: "agent_event",
					taskId: rootNodeId,
					eventType,
					...eventData,
				});
				result = await session.events.next();
			}
			const finalResult = result.value;

			if (finalResult.sessionId) {
				tracker.orchestratorSessionId = finalResult.sessionId;
				await tracker.save();
			}

			// Update root node status based on result
			const didPass = doneRef.done
				? doneRef.done.status === "passed"
				: finalResult.success;
			tracker.updateStatus(rootNodeId, didPass ? "passed" : "failed");

			const totalCostUsd =
				(finalResult.costUsd ?? 0) + costAccumulator.totalCostUsd;
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
					totalCostUsd: costAccumulator.totalCostUsd,
					totalTurns: costAccumulator.totalTurns,
					taskCount: costAccumulator.taskCount,
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
			// Always preserve the orchestrator session for future resume,
			// regardless of how it exited (success, failure, or crash).
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
): { ok: boolean; error?: string; status?: number; sessionId?: string } {
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
	return { ok: true, sessionId: session.sessionId };
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
	try {
		session.queue.enqueue({ source: "clarify_response", answer });
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
