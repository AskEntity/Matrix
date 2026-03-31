import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "../agent-provider.ts";
import { DEFAULT_MODEL } from "../config.ts";
import {
	type Event,
	findOrphanedBackgroundProcesses,
	findOrphanedToolCalls,
	findUnconsumedMessages,
	hasPendingYield,
	type SessionConfigEvent,
} from "../events.ts";
import { McpClientManager } from "../mcp-client.ts";
import type { QueueImage, QueueMessage } from "../message-queue.ts";
import { MessageQueue } from "../message-queue.ts";
import { createOrchestratorTools } from "../orchestrator-tools.ts";
import {
	createClarifyResponse,
	createUserMessage,
} from "../queue-message-factory.ts";
import { buildSystemPrompt, type SystemPrompt } from "../system-prompts.ts";
import type { TaskTracker } from "../task-tracker.ts";
import { slugify } from "../task-utils.ts";
import type { ToolDefinition } from "../tool-definition.ts";
import { MCP_SERVER_NAME, TOOL_DONE } from "../tool-names.ts";
import {
	cleanupSessionBackgroundProcesses,
	createBuiltinTools,
} from "../tools/index.ts";
import type { AgentResult, TaskSession } from "../types.ts";
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
// The emit() function in createOrchestratorTools handles agent_event
// wrappers from MCP tools (child agents forwarding events to parent).

// ── Session config helpers ──

/** Find the last session_config event in active events. */
function findSessionConfig(events: Event[]): SessionConfigEvent | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === "session_config") {
			return events[i] as SessionConfigEvent;
		}
	}
	return undefined;
}

/**
 * Build a session_config event from current state.
 * Used for fresh start and compaction (refreshes config).
 */
function buildSessionConfig(
	systemPrompt: SystemPrompt,
	tools: unknown[],
	taskId: string,
): SessionConfigEvent {
	return {
		type: "session_config",
		tools,
		systemStable: systemPrompt.stable,
		systemVariable: systemPrompt.variable,
		taskId,
		ts: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Shared helpers — extracted from launchAgent / runChildAgentInBackground
// ---------------------------------------------------------------------------

/**
 * Build a user message with pre-loaded context header.
 * Reads memory.md, constructs the header, generates a msgId, and returns
 * both the QueueMessage and the corresponding Event for broadcast.
 */
function prepareAgentMessage(
	projectPath: string,
	taskId: string,
	content: string,
	images?: QueueImage[],
): { msg: QueueMessage; event: Event } {
	const memory = readProjectMemory(projectPath);
	const header = memory
		? `Working directory: ${projectPath}\n\n# .mxd/memory.md (Preloaded, do not read again)\n${memory}`
		: `Working directory: ${projectPath}`;
	const msg = createUserMessage(content, { images, header });
	const event: Event = {
		type: "message",
		id: msg.id,
		taskId,
		body: msg,
		ts: msg.ts,
	};
	return { msg, event };
}

/** Config + tools bundle produced by createAgentContext(). */
interface AgentContextResult {
	provider: ReturnType<typeof getProjectProvider>;
	effectiveCfg: Awaited<ReturnType<typeof resolveProjectConfig>>;
	mcpManager: McpClientManager;
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic is not narrowable here
	mcpToolDefs: Record<string, ToolDefinition<any>[]>;
	hasRunningChildren?: () => boolean;
	buildYieldPendingSection?: () => string;
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
		mcpManager?: McpClientManager;
		/** System prompt for auto-launching target project agents (cross-project). Only needed at depth 0. */
		orchestratorSystemPrompt?: SystemPrompt;
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

	const { toolDefs, hasRunningChildren, buildYieldPendingSection } =
		createOrchestratorTools(
			{
				tracker: opts.tracker,
				repoPath: project.path,
				emit: (event) => {
					const ts = (event.ts as number) || Date.now();
					if (event.type === "agent_event") {
						const evtTaskId = (event.taskId as string) || "";
						const eventType = event.eventType as string;
						const { type: _t, taskId: _tid, eventType: _et, ...rest } = event;
						emitEvent(ctx, project.id, {
							type: eventType,
							taskId: evtTaskId,
							ts,
							...rest,
						} as unknown as Event);
					} else {
						const withTs = event.ts ? event : { ...event, ts };
						emitEvent(ctx, project.id, withTs as unknown as Event);
					}
				},
				broadcastTree: () => broadcastTreeUpdate(ctx, project.id, opts.tracker),
				clearEventStore: (sessionId) =>
					getEventStore(ctx, project.id).clear(sessionId),
				hasEventStore: (sessionId) =>
					getEventStore(ctx, project.id).has(sessionId),
				copySessionFrom: (sourceId, targetId, opts) =>
					getEventStore(ctx, project.id).copySessionFrom(
						sourceId,
						targetId,
						opts,
					),
				dataDir: ctx.config.dataDir,
				getClarifyTimeoutMs: () => ctx.globalConfig?.clarifyTimeoutMs,
				getDefaultBudgetUsd: () => ctx.globalConfig?.budgetUsd,
				listProjects: () =>
					ctx.pm.list().map((p) => ({
						id: p.id,
						name: p.name,
						path: p.path,
						hasActiveAgent: ctx.activeSessions.has(p.id),
					})),
				getProject: (id) => ctx.pm.get(id),
				getTracker: (projectId) => ctx.trackers.get(projectId),
			},
			project.id,
			opts.currentTaskId,
			{
				deliverMessage: async (
					nodeId: string,
					message: QueueMessage,
					opts?: { quiet?: boolean },
				) => {
					await deliverMessage(ctx, project, nodeId, message, opts);
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
			},
		);

	// Create built-in tools with handler closures that read session state
	const builtinTools = createBuiltinTools(
		opts.getSession,
		opts.currentTaskId,
		() => opts.getSession(opts.currentTaskId)?.cwd ?? opts.projectPath,
		() => opts.getSession(opts.currentTaskId)?.fallbackCwd,
		() => opts.getSession(opts.currentTaskId)?.queue,
	);

	const mcpToolDefs: Record<string, ToolDefinition[]> = {
		[MCP_SERVER_NAME]: [...builtinTools, ...toolDefs],
		...mcpManager.getToolDefs(),
	};

	return {
		provider,
		effectiveCfg,
		mcpManager,
		mcpToolDefs,
		hasRunningChildren,
		buildYieldPendingSection,
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
}

/**
 * Shared child agent lifecycle: queue setup → stream events with done() detection → cleanup.
 *
 * Used by `runChildAgentInBackground` for all child agents (both MCP and daemon paths).
 *
 * Done detection: done() handler closes the queue directly (derived from session),
 * which closes the queue before waitForQueueMessages() blocks. The fallback path detects
 * tool_result for mcp__mxd__done and closes the queue (handles edge cases).
 */
export async function runChildCore(
	params: RunChildCoreParams,
): Promise<AgentResult> {
	const { provider, tracker, taskId, sessionRequest } = params;

	// Use pre-created queue or create a new one
	const childQueue = params.queue ?? new MessageQueue();
	sessionRequest.queue = childQueue;

	// Messages are recovered from JSONL via findUnconsumedMessages (already enqueued
	// by the caller). No disk queue — JSONL is the sole persistence path.

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
				event.tool === TOOL_DONE
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
		childQueue.close();
	}
}

// ---------------------------------------------------------------------------

/**
 * Write synthetic tool_result events for any unpaired tool_call in JSONL.
 * Called during stopAgent to prevent orphaned tool_use errors on resume.
 * Delegates to findOrphanedToolCalls (events.ts) for detection — single codepath
 * for orphan rules (yield skip, etc.).
 */
export async function writeOrphanedToolResults(
	eventStore: import("../event-store.ts").EventStore,
	sessionId: string,
): Promise<void> {
	if (!eventStore.has(sessionId)) return;

	const events = eventStore.readActive(sessionId);
	if (events.length === 0) return;

	const orphans = findOrphanedToolCalls(events, sessionId);
	if (orphans.length === 0) return;

	console.warn(
		`[writeOrphanedToolResults] Writing ${orphans.length} orphan(s) for ${sessionId}`,
	);

	// Await to ensure write completes before process.exit during shutdown
	await eventStore.appendBatch(sessionId, orphans);
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

	// Cascade stop to ALL agents (root + children) via session on tracker nodes
	if (tracker) {
		const rootNodeId = tracker.rootNodeId;
		// Close root session
		const rootNode = tracker.get(rootNodeId);
		const rootQueue = rootNode?.session?.queue;
		if (rootQueue) {
			if (rootNode?.session) {
				cleanupSessionBackgroundProcesses(rootNode.session.backgroundProcesses);
				rootNode.session = undefined;
			}
			rootQueue.close();
		} else if (rootNode?.session) {
			cleanupSessionBackgroundProcesses(rootNode.session.backgroundProcesses);
			rootNode.session = undefined;
		}
		for (const node of tracker.allNodes()) {
			if (node.status === "in_progress" && node.id !== rootNodeId) {
				const childQueue = node.session?.queue;
				if (childQueue) {
					if (node.session) {
						cleanupSessionBackgroundProcesses(node.session.backgroundProcesses);
						node.session = undefined;
					}
					childQueue.close();
				} else if (node.session) {
					cleanupSessionBackgroundProcesses(node.session.backgroundProcesses);
					node.session = undefined;
				}
				// Children stay in_progress — they were interrupted, not failed.
				// autoResume will detect them from JSONL state on next restart.
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

	emitEvent(ctx, projectId, {
		type: "agent_stopped",
		taskId: tracker?.rootNodeId ?? "",
		ts: Date.now(),
	});
}

/**
 * Stop a single task's agent. Closes its queue, cleans up session state,
 * and writes orphaned tool results. Unlike stopAgent() which stops the entire
 * project (root + all children), this only stops the specified task.
 *
 * The task stays in_progress — it was interrupted, not failed.
 * Can be resumed by sending a new message.
 */
export async function stopTask(
	ctx: DaemonContext,
	projectId: string,
	nodeId: string,
): Promise<boolean> {
	const tracker = ctx.trackers.get(projectId);
	if (!tracker) return false;

	const node = tracker.get(nodeId);
	if (!node) return false;

	const queue = node.session?.queue;
	if (!queue && !node.session) return false;

	// Close queue and clean up session
	if (node.session) {
		cleanupSessionBackgroundProcesses(node.session.backgroundProcesses);
		node.session = undefined;
	}
	if (queue) {
		queue.close();
	}

	await tracker.save();
	broadcastTreeUpdate(ctx, projectId, tracker);

	// Write orphaned tool results so resume doesn't hit API 400
	const eventStore = getEventStore(ctx, projectId);
	await writeOrphanedToolResults(eventStore, nodeId);

	emitEvent(ctx, projectId, {
		type: "agent_stopped",
		taskId: nodeId,
		ts: Date.now(),
	});

	return true;
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
 * THE single message delivery path. All message delivery goes through here.
 * Handles: JSONL persistence (SSE + persist), queue delivery (if running), auto-launch (if not).
 *
 * Callers must NOT call emitEvent separately for the message — deliverMessage owns that.
 *
 * @param opts.quiet - If true, skip auto-launch when agent is not running.
 *   Used for notifications (tree_change) that shouldn't wake stopped agents.
 *
 * @returns "enqueued" if delivered to a running agent's queue,
 *          "persisted" if written to JSONL (agent not running).
 */
export async function deliverMessage(
	ctx: DaemonContext,
	project: { id: string; path: string },
	nodeId: string,
	message: QueueMessage,
	opts?: { quiet?: boolean; orchestratorSystemPrompt?: SystemPrompt },
): Promise<"enqueued" | "persisted"> {
	const tracker = await getTracker(ctx, project.id);
	const eventStore = getEventStore(ctx, project.id);

	// Check resume state BEFORE writing the message — the event we're about
	// to write shouldn't influence the fresh-vs-resume decision.
	const shouldResume = eventStore.has(nodeId);

	// Step 1: ALWAYS write to JSONL (SSE broadcast + persistence).
	// This ensures findUnconsumedMessages can recover it on restart.
	emitEvent(ctx, project.id, {
		type: "message",
		id: message.id,
		taskId: nodeId,
		body: message,
		ts: message.ts,
	});

	// Step 2: Try direct queue delivery if agent is running
	const queue = tracker.get(nodeId)?.session?.queue;
	if (queue) {
		try {
			queue.enqueue(message);
			return "enqueued";
		} catch {
			// Queue was closed — fall through to persist/launch
		}
	}

	// Step 3: Agent not running — flush JSONL.
	await eventStore.flushSession(nodeId);

	// Step 4: Auto-launch (unless quiet).
	if (!opts?.quiet) {
		const node = tracker.get(nodeId);
		if (node?.parentId) {
			// Child node — launch in background
			ensureChildAgentRunning(ctx, project, tracker, nodeId).catch((e) => {
				emitEvent(ctx, project.id, {
					type: "error",
					taskId: nodeId,
					message: `Auto-launch failed: ${e instanceof Error ? e.message : String(e)}`,
					ts: Date.now(),
				});
			});
		} else if (
			opts?.orchestratorSystemPrompt &&
			!ctx.restartingProjects.has(project.id)
		) {
			// Root node — launch foreground session
			await launchAgent(
				ctx,
				project,
				{ resume: shouldResume },
				opts.orchestratorSystemPrompt,
			);
		}
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
	if (node.session != null) {
		return;
	}

	// Create worktree if the task doesn't have one yet
	if (!node.worktreePath) {
		const parentNode = node.parentId ? tracker.get(node.parentId) : null;
		const baseBranch = parentNode?.branch;
		if (!baseBranch) {
			throw new Error(
				`Cannot create worktree for task ${nodeId} — parent has no branch assigned.`,
			);
		}
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);
		const wt = await wm.create(node.id, slugify(node.title), baseBranch);
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

// findParentQueue moved to agent-tools.ts to avoid circular imports
// (orchestrator-tools.ts needs it, and agent-lifecycle.ts imports from orchestrator-tools.ts)

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
			mcpManager,
			getSession,
		});

		// Read active events for resume and fix orphaned tool_calls
		const eventStore = getEventStore(ctx, project.id);
		let activeEvents = eventStore.has(nodeId)
			? eventStore.readActive(nodeId)
			: [];
		if (activeEvents.length > 0) {
			const orphanFixes = findOrphanedToolCalls(activeEvents, nodeId);
			if (orphanFixes.length > 0) {
				await eventStore.appendBatch(nodeId, orphanFixes);
				activeEvents = [...activeEvents, ...orphanFixes];
			}

			// Write synthetic background_complete for bg processes killed by restart.
			// For yielding agents: enqueue to queue instead of writing to JSONL
			// (events between yield tool_call and its tool_result break the converter).
			const bgOrphans = findOrphanedBackgroundProcesses(activeEvents, nodeId);
			const childIsYielding = hasPendingYield(activeEvents);
			if (bgOrphans.length > 0 && !childIsYielding) {
				await eventStore.appendBatch(nodeId, bgOrphans);
				activeEvents = [...activeEvents, ...bgOrphans];
			}
			if (bgOrphans.length > 0 && childIsYielding) {
				for (const orphan of bgOrphans) {
					if (orphan.type === "message" && orphan.body) {
						childQueue.enqueue(orphan.body);
					}
				}
			}

			// Recover unconsumed messages (same issue as root — see launchAgent)
			const unconsumed = findUnconsumedMessages(activeEvents);
			for (const msg of unconsumed) {
				childQueue.enqueue(msg);
			}
		}

		// Build emit callback: emitEvent with taskId injected
		const emitWithTask = (event: Event) => {
			const withTaskId = { ...event, taskId: nodeId };
			emitEvent(ctx, project.id, withTaskId as Event);
		};

		// Notify UI that this child agent is now active
		emitEvent(ctx, project.id, {
			type: "orchestration_started",
			taskId: nodeId,
			resume: eventStore.has(nodeId),
			provider: agentCtx.provider.name,
			model: agentCtx.effectiveCfg.model ?? DEFAULT_MODEL,
			ts: Date.now(),
		});

		// Resolve system prompt: use stored session_config on resume, fresh on start.
		const isChildResume = activeEvents.length > 0;
		const storedConfig = isChildResume
			? findSessionConfig(activeEvents)
			: undefined;
		let childSystemPrompt: SystemPrompt;
		if (storedConfig) {
			// Resume: use frozen system prompt from JSONL for cache stability
			childSystemPrompt = {
				stable: storedConfig.systemStable,
				variable: storedConfig.systemVariable,
			};
		} else {
			// Fresh start or migration: build fresh system prompt
			childSystemPrompt = buildSystemPrompt();
			const configEvt = buildSessionConfig(
				childSystemPrompt,
				[], // Tools are rebuilt by the provider on each launch
				nodeId,
			);
			emitEvent(ctx, project.id, { ...configEvt, taskId: nodeId });
			activeEvents = [configEvt, ...activeEvents];
		}

		const agentResult = await runChildCore({
			provider: agentCtx.provider,
			tracker,
			taskId: nodeId,
			queue: childQueue,
			sessionRequest: {
				cwd: node.worktreePath as string,
				emit: emitWithTask,
				activeEvents,
				systemPrompt: childSystemPrompt,
				refreshSystemPrompt: () => buildSystemPrompt(),
				resumeSessionId: nodeId,
				model: agentCtx.effectiveCfg.model,
				mcpToolDefs: agentCtx.mcpToolDefs,
				hasRunningChildren: agentCtx.hasRunningChildren,
				buildYieldPendingSection: agentCtx.buildYieldPendingSection,
				getSession,
			},
		});

		// --- Post-completion logic (unified for both MCP and daemon paths) ---

		// Cost reporting
		if (agentResult.costUsd > 0) {
			tracker.updateCost(nodeId, agentResult.costUsd);
		}

		// Budget exceeded check
		const updatedNode = tracker.get(nodeId);
		if (updatedNode?.budgetUsd && updatedNode.costUsd > updatedNode.budgetUsd) {
			emitEvent(ctx, project.id, {
				type: "budget_exceeded",
				taskId: nodeId,
				title: node.title,
				costUsd: updatedNode.costUsd,
				budgetUsd: updatedNode.budgetUsd,
				ts: Date.now(),
			});
		}

		// done() tool updates status directly in the tracker and delivers
		// task_complete to the parent queue. That is the ONLY path for task_complete.
		// If done() was NOT called, the agent was interrupted (stop, reset, error,
		// queue close, daemon restart). Status stays in_progress — agent is resumable.
		// No fallback task_complete — the parent is not notified of interruptions.
		await tracker.save();

		broadcastTreeUpdate(ctx, project.id, tracker);
	} catch (e) {
		// Error = interrupted. Status stays in_progress — agent is resumable.
		// No task_complete to parent. Just emit error event so UI knows what happened.
		const errorMsg = e instanceof Error ? e.message : String(e);
		emitEvent(ctx, project.id, {
			type: "error",
			taskId: nodeId,
			message: `Child agent error: ${errorMsg}`,
			ts: Date.now(),
		});
		await tracker.save();

		broadcastTreeUpdate(ctx, project.id, tracker);
	} finally {
		// Clean up session: background processes + detach from node
		const finalNode = tracker.get(nodeId);
		if (finalNode?.session) {
			cleanupSessionBackgroundProcesses(finalNode.session.backgroundProcesses);
			finalNode.session = undefined;
		}
		await mcpManager.disconnectAll();

		// Notify UI that this child agent is no longer active
		emitEvent(ctx, project.id, {
			type: "agent_stopped",
			taskId: nodeId,
			ts: Date.now(),
		});
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
	orchestratorSystemPrompt: SystemPrompt,
) {
	const tracker = ctx.trackers.get(project.id);
	if (!tracker) return;

	// Root node always exists (created at tracker load time)
	const rootNodeId = tracker.rootNodeId;
	const rootNode = tracker.get(rootNodeId);
	if (!rootNode) return; // Should never happen — root always exists
	tracker.updateStatus(rootNodeId, "in_progress");
	tracker.save().catch((e) => {
		console.warn("[agent-lifecycle] Failed to save tracker on agent start:", e);
	});

	const queue = new MessageQueue();

	const mcpManager = new McpClientManager();

	// getSession lookup: find session from tracker by sessionId
	const getSession = (sid: string) => tracker.get(sid)?.session;

	const agentCtx = await createAgentContext(ctx, project, {
		tracker,
		projectPath: project.path,
		currentTaskId: rootNodeId,
		depth: 0,
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

	// Read active events for resume and fix orphaned tool_calls
	const eventStore = getEventStore(ctx, project.id);
	let rootActiveEvents = eventStore.has(rootNodeId)
		? eventStore.readActive(rootNodeId)
		: [];
	if (rootActiveEvents.length > 0) {
		const orphanFixes = findOrphanedToolCalls(rootActiveEvents, rootNodeId);
		if (orphanFixes.length > 0) {
			await eventStore.appendBatch(rootNodeId, orphanFixes);
			rootActiveEvents = [...rootActiveEvents, ...orphanFixes];
		}

		// Write synthetic background_complete for bg processes killed by restart.
		// Frontend uses these to remove stale entries from the background processes UI.
		// For yielding agents: DON'T write to JSONL (breaks converter — events between
		// yield tool_call and its tool_result cause API 400). Enqueue to queue instead.
		const bgOrphans = findOrphanedBackgroundProcesses(
			rootActiveEvents,
			rootNodeId,
		);
		const isYielding = hasPendingYield(rootActiveEvents);
		if (bgOrphans.length > 0 && !isYielding) {
			await eventStore.appendBatch(rootNodeId, bgOrphans);
			rootActiveEvents = [...rootActiveEvents, ...bgOrphans];
		}

		// For yielding agents, enqueue bg_complete to queue instead of JSONL.
		// The provider loop will deliver them to the agent via queue drain when yield resolves.
		if (bgOrphans.length > 0 && isYielding) {
			for (const orphan of bgOrphans) {
				if (orphan.type === "message" && orphan.body) {
					queue.enqueue(orphan.body);
				}
			}
		}

		// Recover messages that were persisted to JSONL but never consumed.
		// This happens when a message arrives during tool execution (enqueued to live queue),
		// gets written to JSONL as a `message` event, but daemon crashes before the provider
		// loop can drain the queue and emit `messages_consumed`. Re-enqueue them so the
		// agent receives them on resume. These are chronologically BEFORE any persistent
		// queue messages (which were sent after the restart), so enqueue them first.
		const unconsumed = findUnconsumedMessages(rootActiveEvents);
		for (const msg of unconsumed) {
			queue.enqueue(msg);
		}
	}

	// Messages are recovered from JSONL via findUnconsumedMessages above.
	// No disk queue — JSONL is the sole persistence path.

	// Resolve system prompt: use stored session_config on resume, fresh on start.
	const isRootResume = rootActiveEvents.length > 0;
	const storedRootConfig = isRootResume
		? findSessionConfig(rootActiveEvents)
		: undefined;
	let systemPrompt: SystemPrompt;
	if (storedRootConfig) {
		// Resume: use frozen system prompt from JSONL for cache stability
		systemPrompt = {
			stable: storedRootConfig.systemStable,
			variable: storedRootConfig.systemVariable,
		};
	} else {
		// Fresh start or migration: build fresh system prompt
		systemPrompt = agentCtx.effectiveCfg.selfBootstrap
			? buildSystemPrompt({ selfBootstrap: true })
			: orchestratorSystemPrompt;
		const configEvt = buildSessionConfig(systemPrompt, [], rootNodeId);
		emitEvent(ctx, project.id, { ...configEvt, taskId: rootNodeId });
		rootActiveEvents = [configEvt, ...rootActiveEvents];
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
		refreshSystemPrompt: () =>
			agentCtx.effectiveCfg.selfBootstrap
				? buildSystemPrompt({ selfBootstrap: true })
				: buildSystemPrompt(),
		mcpToolDefs: agentCtx.mcpToolDefs,
		resumeSessionId,
		model: effectiveModel,
		queue,
		hasRunningChildren: agentCtx.hasRunningChildren,
		buildYieldPendingSection: agentCtx.buildYieldPendingSection,
		getSession,
		isOrchestrator: true,
	});

	ctx.activeSessions.set(project.id, session);

	// Fire-and-forget: consume events in background
	(async () => {
		let caughtError = false;
		try {
			const finalResult = await consumeAgentEvents(session.events);

			// done() tool updates status directly in the tracker and delivers
			// task_complete to the parent. That is the ONLY path for status change.
			// If done() was NOT called, agent was interrupted — status stays in_progress.
			// No implicit pass fallback.
			const currentRoot = tracker.get(rootNodeId);
			const didPass = currentRoot?.status === "passed";

			// Sum child costs from the tree (source of truth)
			const allNodes = tracker.allNodes();
			const childNodes = allNodes.filter(
				(n) => n.id !== rootNodeId && n.costUsd > 0,
			);
			const childCostUsd = childNodes.reduce((sum, n) => sum + n.costUsd, 0);
			const totalCostUsd = finalResult.costUsd + childCostUsd;
			emitEvent(ctx, project.id, {
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
			// Error = interrupted. Status stays in_progress — agent is resumable.
			// No status change, no task_complete. Just emit error so UI knows.
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
			} catch (e) {
				console.warn(
					"[agent-lifecycle] Failed to save tracker during cleanup:",
					e,
				);
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

// --- Shared handlers (used by REST routes) ---

/**
 * Inject a user message into the root agent (running or stopped).
 * Thin wrapper over deliverMessage that handles cold-start header.
 *
 * Used by POST /tasks/:nodeId/message (root branch) and cross-project messaging.
 */
export async function handleInjectMessage(
	ctx: DaemonContext,
	projectId: string,
	message: string,
	images?: QueueImage[],
	orchestratorSystemPrompt?: SystemPrompt,
): Promise<{ ok: boolean; error?: string; status?: number }> {
	const project = ctx.pm.get(projectId);
	if (!project) {
		return { ok: false, error: "Project not found", status: 404 };
	}

	const tracker = await getTracker(ctx, projectId);
	const rootNodeId = tracker.rootNodeId;
	const eventStore = getEventStore(ctx, projectId);

	// Only include header (memory.md + working dir) on true cold start.
	// Resume agents already have context from their JSONL session.
	const shouldResume = eventStore.has(rootNodeId);
	const msg = shouldResume
		? createUserMessage(message, { images })
		: prepareAgentMessage(project.path, rootNodeId, message, images).msg;

	// deliverMessage handles JSONL, queue delivery, and auto-launch (root + child).
	await deliverMessage(ctx, project, rootNodeId, msg, {
		orchestratorSystemPrompt,
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
	const project = ctx.pm.get(projectId);
	if (!project) {
		return { ok: false, error: "Project not found", status: 404 };
	}

	// Single delivery path — handles JSONL + queue + auto-launch
	const clarifyMsg = createClarifyResponse(answer);
	await deliverMessage(ctx, project, taskId, clarifyMsg);

	removePendingClarification(ctx, projectId, taskId, clarificationId);
	emitEvent(ctx, projectId, {
		type: "clarification_answered",
		taskId,
		answer,
		ts: Date.now(),
	});
	return { ok: true };
}
