import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "../agent-provider.ts";
import { DEFAULT_MODEL } from "../config.ts";
import {
	buildSessionRepair,
	type Event,
	findOrphanedBackgroundProcesses,
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
	createTaskComplete,
	createUserMessage,
} from "../queue-message-factory.ts";
import { buildSystemPrompt, type SystemPrompt } from "../system-prompts.ts";
import type { TaskTracker } from "../task-tracker.ts";
import { slugify } from "../task-utils.ts";
import type { ToolDefinition } from "../tool-definition.ts";
import { MCP_SERVER_NAME } from "../tool-names.ts";
import {
	cleanupSessionBackgroundProcesses,
	createBuiltinTools,
} from "../tools/index.ts";
import { type AgentResult, isTask, type TaskSession } from "../types.ts";
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

// session_config is emitted by runProviderLoop (with populated tools).
// Previously buildSessionConfig lived here but wrote tools=[] (bug).

// ---------------------------------------------------------------------------
// Shared helpers — used by runAgentForNode
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
	/** Bind live messages[] from provider loop for evaluate_script (selfBootstrap). */
	setMessages?: (msgs: unknown[]) => void;
	/** Bind frozen JsonTool[] from provider loop for evaluate_script (selfBootstrap). */
	setAllTools?: (tools: unknown[]) => void;
}

/**
 * Resolve project config, create a provider, connect external MCP servers,
 * and build orchestrator tools. Used by runAgentForNode.
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
		await mcpManager.connectAll(effectiveCfg.mcpServers, opts.projectPath);
	}

	const { toolDefs, hasRunningChildren, setMessages, setAllTools } =
		createOrchestratorTools(
			{
				tracker: opts.tracker,
				repoPath: project.path,
				daemonCtx: ctx,
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
						hasActiveAgent: (() => {
							const t = ctx.trackers.get(p.id);
							return t ? t.getTask(t.rootNodeId)?.session != null : false;
						})(),
					})),
				getProject: (id) => ctx.pm.get(id),
				getTracker: (projectId) => ctx.trackers.get(projectId),
				stopTask: (nodeId) => stopTask(ctx, project.id, nodeId),
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
			effectiveCfg.selfBootstrap,
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
		[MCP_SERVER_NAME]: [...(builtinTools as ToolDefinition[]), ...toolDefs],
		...mcpManager.getToolDefs(),
	};

	return {
		provider,
		effectiveCfg,
		mcpManager,
		mcpToolDefs,
		hasRunningChildren,
		setMessages,
		setAllTools,
	};
}

// ---------------------------------------------------------------------------
// runChildCore — shared child agent lifecycle for both MCP and daemon paths
// ---------------------------------------------------------------------------

/** Parameters for runChildCore(). */
export interface RunChildCoreParams {
	/** The agent provider to use for streaming. */
	provider: AgentProvider;
	/** @deprecated No longer used — done() is detected by the provider loop. Kept for caller compat. */
	tracker?: TaskTracker;
	/** @deprecated No longer used — done() is detected by the provider loop. Kept for caller compat. */
	taskId?: string;
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
 * Done detection: done() is an intended orphan — the provider loop detects it
 * and exits immediately (no tool_result emitted). The generator finishes with
 * the AgentResult. Phase 2 status update happens in runAgentForNode after this returns.
 */
export async function runChildCore(
	params: RunChildCoreParams,
): Promise<AgentResult> {
	const { provider, sessionRequest } = params;

	// Use pre-created queue or create a new one
	const childQueue = params.queue ?? new MessageQueue();
	sessionRequest.queue = childQueue;

	// Messages are recovered from JSONL via findUnconsumedMessages (already enqueued
	// by the caller). No disk queue — JSONL is the sole persistence path.

	try {
		const stream = provider.stream(sessionRequest);
		let result = await stream.next();
		while (!result.done) {
			result = await stream.next();
		}
		return result.value;
	} finally {
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
	const tracker = ctx.trackers.get(projectId);
	if (!tracker) return;

	const rootNodeId = tracker.rootNodeId;
	const rootNode = tracker.getTask(rootNodeId);

	// Check if root agent is actually running
	if (!rootNode?.session) return;

	// Stop ALL agents (root + children) via session on tracker nodes.
	// Each node's session has its own queue + abort controller.
	for (const node of tracker.allNodes()) {
		if (isTask(node) && node.session) {
			node.session.queue.close();
			node.session.abortController.abort();
			cleanupSessionBackgroundProcesses(node.session.backgroundProcesses);
			node.session = undefined;
		}
	}

	await tracker.save();
	broadcastTreeUpdate(ctx, projectId, tracker);

	// Clear pending clarifications
	ctx.pendingClarifications.delete(projectId);
	broadcast(ctx.sseClients, projectId, {
		type: "pending_clarifications",
		projectId,
		clarifications: [],
	});

	// NOTE: Do NOT write orphaned tool_results here. The provider loop may still be
	// settling (e.g. bg process killed → completionPromise resolves → provider loop
	// emits real tool_result). Writing synthetic orphans now races with those writes,
	// producing duplicate tool_results → API 400 on resume.
	// Orphan detection runs reliably at restart (autoResumeProjects / launchAgent)
	// when the provider loop is guaranteed dead.

	emitEvent(ctx, projectId, {
		type: "agent_stopped",
		taskId: rootNodeId,
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

	const node = tracker.getTask(nodeId);
	if (!node) return false;

	if (!node.session) return false;

	// Grab the loop promise BEFORE clearing session — once session is gone,
	// the loop's finally block will fire and resolve this promise.
	const loopPromise = ctx.agentLoopPromises.get(nodeId);

	// Resolve foreground executions (bash sleep etc.) so the loop can exit promptly.
	for (const fg of node.session.foregroundExecutions.values()) {
		fg.resolve();
	}
	node.session.foregroundExecutions.clear();

	// Close queue, abort in-flight API calls, and clean up session
	node.session.queue.close();
	node.session.abortController.abort();
	cleanupSessionBackgroundProcesses(node.session.backgroundProcesses);
	node.session = undefined;

	// Await loop exit — ensures finally block (agent_stopped, MCP disconnect,
	// Phase 2 done) has completed before we return. Without this, callers
	// (e.g., resetTask) that clear JSONL after stopTask would race with the
	// loop's async cleanup writing events to the deleted JSONL.
	if (loopPromise) {
		await loopPromise;
	}

	await tracker.save();
	broadcastTreeUpdate(ctx, projectId, tracker);

	// NOTE: Do NOT write orphaned tool_results here — same race as stopAgent.
	// Orphan detection runs at restart when the provider loop is fully dead.

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

	// Step 2: Try direct queue delivery if agent is running AND fully initialized.
	// Skip if launch lock is held — the agent is still reading JSONL events.
	// Our message is already in JSONL (step 1) and will be recovered by findUnconsumedMessages.
	if (!ctx.launchingNodes.has(nodeId)) {
		const queue = tracker.getTask(nodeId)?.session?.queue;
		if (queue) {
			try {
				queue.enqueue(message);
				return "enqueued";
			} catch {
				// Queue was closed — fall through to persist/launch
			}
		}
	}

	// Step 3: Agent not running — flush JSONL.
	await eventStore.flushSession(nodeId);

	// Step 4: Auto-launch (unless quiet).
	if (!opts?.quiet) {
		const node = tracker.getTask(nodeId);
		if (!node) {
			// Unknown node — message persisted to JSONL but no launch
		} else if (node.parentId) {
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
			!ctx.restartingProjects.has(project.id) &&
			!ctx.launchingNodes.has(nodeId)
		) {
			// Root node — same launch path as child
			tracker.updateStatus(nodeId, "in_progress");
			runAgentForNode(ctx, project, tracker, nodeId, {
				orchestratorSystemPrompt: opts.orchestratorSystemPrompt,
				resume: shouldResume,
			}).catch((e) => {
				emitEvent(ctx, project.id, {
					type: "error",
					taskId: nodeId,
					message: `Root launch failed: ${e instanceof Error ? e.message : String(e)}`,
					ts: Date.now(),
				});
			});
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
	const node = tracker.getTask(nodeId);
	if (!node) return;

	// Guard: if agent is already running or being launched, do nothing.
	// Message was already enqueued to JSONL by deliverMessage — the agent picks it up.
	if (node.session != null || ctx.launchingNodes.has(nodeId)) {
		return;
	}

	// Create worktree if the task doesn't have one yet, or if the directory was deleted
	if (!node.worktreePath || !existsSync(node.worktreePath)) {
		if (node.worktreePath && !existsSync(node.worktreePath)) {
			// Stale worktreePath — directory was deleted outside close_task
			node.worktreePath = null;
			node.branch = null;
		}
		// Use getTaskAbove to skip folders — a folder has no branch to branch from
		const parentNode = tracker.getTaskAbove(nodeId);
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
	await runAgentForNode(ctx, project, tracker, nodeId, { model });
}

/** Compute the depth of a task in the tree by walking up the parentId chain. */
/** Compute depth by counting task ancestors (folders are transparent). */
function computeDepth(tracker: TaskTracker, nodeId: string): number {
	let depth = 0;
	let current = tracker.getTaskAbove(nodeId);
	while (current) {
		depth++;
		current = tracker.getTaskAbove(current.id);
	}
	return depth;
}

// findParentQueue moved to agent-tools.ts to avoid circular imports
// (orchestrator-tools.ts needs it, and agent-lifecycle.ts imports from orchestrator-tools.ts)

/** Run a child agent in the background for a specific task node. */
/** Options for running an agent node. */
interface RunAgentOpts {
	/** Model override (from API parameter). */
	model?: string;
	/** System prompt for fresh root start (non-selfBootstrap projects). */
	orchestratorSystemPrompt?: SystemPrompt;
	/** Whether this is a resume (pre-computed by caller). Used for orchestration_started event. */
	resume?: boolean;
}

/** Run an agent for any node (root or child). Shared launch path. */
export async function runAgentForNode(
	ctx: DaemonContext,
	project: { id: string; path: string },
	tracker: TaskTracker,
	nodeId: string,
	opts?: RunAgentOpts,
): Promise<void> {
	const node = tracker.getTask(nodeId);
	if (!node) return;
	const isRoot = !node.parentId;
	const agentCwd = isRoot ? project.path : (node.worktreePath as string);
	if (!agentCwd) return;

	// Launch lock: prevent duplicate launches when messages arrive before session is established.
	if (node.session != null || ctx.launchingNodes.has(nodeId)) {
		return;
	}
	ctx.launchingNodes.add(nodeId);

	// Track loop promise so stopTask/resetTask can await loop exit.
	// Resolved in finally block after ALL cleanup (including Phase 2) completes.
	let resolveLoopPromise: (() => void) | undefined;
	const loopPromise = new Promise<void>((resolve) => {
		resolveLoopPromise = resolve;
	});
	ctx.agentLoopPromises.set(nodeId, loopPromise);

	const mcpManager = new McpClientManager();
	let ownSession: TaskSession | undefined;
	// Declared outside try so Phase 2 (after finally) can access the result.
	let agentResult: AgentResult | undefined;
	try {
		// Compute depth from the tree
		const depth = computeDepth(tracker, nodeId);

		// Create the queue first — shared between MCP tools and runChildCore
		const childQueue = new MessageQueue();

		// Create and attach TaskSession to the node
		const abortController = new AbortController();
		const taskSession: TaskSession = {
			queue: childQueue,
			abortController,
			cwd: agentCwd,
			fallbackCwd: agentCwd,
			depth,
			backgroundProcesses: new Map(),
			foregroundExecutions: new Map(),
		};
		node.session = taskSession;
		ownSession = taskSession;

		// getSession lookup: find session from tracker by sessionId
		const getSession = (sid: string) => tracker.getTask(sid)?.session;

		const agentCtx = await createAgentContext(ctx, project, {
			tracker,
			projectPath: agentCwd,
			currentTaskId: nodeId,
			depth,
			mcpManager,
			orchestratorSystemPrompt: isRoot
				? opts?.orchestratorSystemPrompt
				: undefined,
			getSession,
		});

		// Priority: API param > resolved config
		const effectiveModel = opts?.model ?? agentCtx.effectiveCfg.model;

		// Flush pending JSONL writes before reading — ensures messages persisted by
		// concurrent deliverMessage calls (during the lock window) are on disk.
		const eventStore = getEventStore(ctx, project.id);
		await eventStore.flushSession(nodeId);

		// Read active events for resume and repair JSONL if needed
		let activeEvents = eventStore.has(nodeId)
			? eventStore.readActive(nodeId)
			: [];
		if (activeEvents.length > 0) {
			// JSONL repair: truncate-and-rebuild if session has problems
			// (duplicate tool_results, orphaned tool_calls, etc.)
			// Handles both daemon restart orphans and accumulated poison
			// from previous sessions where auto-recovery only fixed memory.
			const repair = buildSessionRepair(activeEvents, nodeId);
			if (repair) {
				const needsTruncation =
					repair.truncateAfterIndex < activeEvents.length - 1;
				console.warn(
					`[runAgentForNode] Repairing session ${nodeId}: ${needsTruncation ? `truncate after index ${repair.truncateAfterIndex}` : "append only"}, ${repair.appendEvents.length} events to add`,
				);
				if (needsTruncation) {
					await eventStore.truncateAfterLine(nodeId, repair.truncateAfterIndex);
				}
				if (repair.appendEvents.length > 0) {
					await eventStore.appendBatch(nodeId, repair.appendEvents);
				}
				// Re-read events after repair
				activeEvents = eventStore.readActive(nodeId);
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

			// Recover unconsumed messages
			const unconsumed = findUnconsumedMessages(activeEvents);
			for (const msg of unconsumed) {
				childQueue.enqueue(msg);
			}
		}

		// Release launch lock. deliverMessage skips direct queue delivery while
		// lock is held, so messages written during the lock window are in JSONL
		// and were recovered above by findUnconsumedMessages.
		// After lock release, messages go directly to the queue via deliverMessage.
		ctx.launchingNodes.delete(nodeId);

		// Build emit callback: emitEvent with taskId injected + streaming text tracking
		const emitWithTask = (event: Event) => {
			const withTaskId = { ...event, taskId: nodeId };
			// Track streaming text for partial injection into batch events API
			if (event.type === "text_delta") {
				const existing = ctx.streamingText.get(nodeId) ?? "";
				ctx.streamingText.set(nodeId, existing + event.content);
			} else if (event.type === "assistant_text") {
				ctx.streamingText.delete(nodeId);
			}
			emitEvent(ctx, project.id, withTaskId as Event);
		};

		// Notify UI that this agent is now active
		emitEvent(ctx, project.id, {
			type: "orchestration_started",
			taskId: nodeId,
			resume: opts?.resume ?? eventStore.has(nodeId),
			provider: agentCtx.provider.name,
			model: effectiveModel ?? DEFAULT_MODEL,
			ts: Date.now(),
		});

		// Cache TTL: root gets 1h, regular children get default 5min.
		// On resume, inherit from stored session_config (fork copies this automatically).
		const cacheTtl: "1h" | undefined = isRoot ? "1h" : undefined;

		// Resolve system prompt: use stored session_config on resume, fresh on start.
		const isResume = activeEvents.length > 0;
		const storedConfig = isResume ? findSessionConfig(activeEvents) : undefined;
		let systemPrompt: SystemPrompt;
		// On resume, use cacheTtl from stored config (preserves fork inheritance).
		// On fresh start, use computed cacheTtl.
		const effectiveCacheTtl = storedConfig?.cacheTtl ?? cacheTtl;
		if (storedConfig) {
			// Resume: use frozen system prompt from JSONL for cache stability
			systemPrompt = {
				stable: storedConfig.systemStable,
				variable: storedConfig.systemVariable,
			};
		} else {
			// Fresh start or migration: build fresh system prompt
			// Root: selfBootstrap flag or orchestratorSystemPrompt; child: default
			if (isRoot && agentCtx.effectiveCfg.selfBootstrap) {
				systemPrompt = buildSystemPrompt({ selfBootstrap: true });
			} else if (isRoot && opts?.orchestratorSystemPrompt) {
				systemPrompt = opts.orchestratorSystemPrompt;
			} else {
				systemPrompt = buildSystemPrompt();
			}
			// session_config is emitted by runProviderLoop after tools are built.
			// Previously we emitted here with tools=[] — now tools are populated.
		}

		const refreshSystemPrompt = () =>
			isRoot && agentCtx.effectiveCfg.selfBootstrap
				? buildSystemPrompt({ selfBootstrap: true })
				: buildSystemPrompt();

		const sessionRequest: AgentRequest = {
			cwd: agentCwd,
			projectPath: isRoot ? project.path : undefined,
			emit: emitWithTask,
			activeEvents,
			systemPrompt,
			refreshSystemPrompt,
			resumeSessionId: nodeId,
			model: effectiveModel,
			mcpToolDefs: agentCtx.mcpToolDefs,
			hasRunningChildren: agentCtx.hasRunningChildren,
			getSession,
			cacheTtl: effectiveCacheTtl,
			setMessages: agentCtx.setMessages,
			setAllTools: agentCtx.setAllTools,

			signal: abortController.signal,
			queue: childQueue,
		};

		// Root agents: stream directly — done() enters idle-yield, session stays alive.
		// Child agents: runChildCore adds done() detection — queue close on done.
		if (isRoot) {
			const stream = agentCtx.provider.stream(sessionRequest);
			let result = await stream.next();
			while (!result.done) {
				result = await stream.next();
			}
			agentResult = result.value;
		} else {
			agentResult = await runChildCore({
				provider: agentCtx.provider,
				tracker,
				taskId: nodeId,
				queue: childQueue,
				sessionRequest,
			});
		}

		// --- Post-completion logic (unified for both MCP and daemon paths) ---

		// Cost reporting
		if (agentResult.costUsd > 0) {
			tracker.updateCost(nodeId, agentResult.costUsd);
		}

		// Budget exceeded check
		const updatedNode = tracker.getTask(nodeId);
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

		// Root agent: emit orchestration_completed with aggregated costs
		if (isRoot) {
			const currentNode = tracker.getTask(nodeId);
			const didPass = currentNode?.status === "verify";
			const allTaskNodes = tracker.allNodes().filter(isTask);
			const childNodes = allTaskNodes.filter(
				(n) => n.id !== nodeId && n.costUsd > 0,
			);
			const childCostUsd = childNodes.reduce((sum, n) => sum + n.costUsd, 0);
			const totalCostUsd = agentResult.costUsd + childCostUsd;
			emitEvent(ctx, project.id, {
				type: "orchestration_completed",
				taskId: nodeId,
				success: didPass,
				costUsd: totalCostUsd,
				turns: agentResult.turns,
				inputTokens: agentResult.inputTokens,
				cacheCreationTokens: agentResult.cacheCreationTokens,
				cacheReadTokens: agentResult.cacheReadTokens,
				outputTokens: agentResult.outputTokens,
				childCosts: {
					totalCostUsd: childCostUsd,
					totalTurns: 0,
					taskCount: childNodes.length,
				},
				ts: Date.now(),
			});
		}

		await tracker.save();
		broadcastTreeUpdate(ctx, project.id, tracker);
	} catch (e) {
		// Check if our session was replaced (stopTask/stopAgent already cleaned up).
		// If so, suppress error events — they'd be stale leaks from an old session.
		const replacedNode = tracker.getTask(nodeId);
		const wasReplaced =
			!replacedNode?.session || replacedNode.session !== ownSession;
		if (!wasReplaced) {
			// Error = interrupted. Status stays in_progress — agent is resumable.
			// No task_complete to parent. Just emit error event so UI knows what happened.
			const errorMsg = e instanceof Error ? e.message : String(e);
			emitEvent(ctx, project.id, {
				type: "error",
				taskId: nodeId,
				message: `Agent error: ${errorMsg}`,
				ts: Date.now(),
			});
		}
		await tracker.save();

		broadcastTreeUpdate(ctx, project.id, tracker);
	} finally {
		// Ensure launch lock is released (covers error path before session established)
		ctx.launchingNodes.delete(nodeId);
		// Clean up streaming text accumulator
		ctx.streamingText.delete(nodeId);
		// Clean up session: background processes + detach from node.
		// Only clear if this is still OUR session — a replacement agent
		// may have already set a new session on the node.
		const finalNode = tracker.getTask(nodeId);
		const sessionWasReplaced =
			!finalNode?.session || finalNode.session !== ownSession;
		if (finalNode?.session && finalNode.session === ownSession) {
			cleanupSessionBackgroundProcesses(finalNode.session.backgroundProcesses);
			finalNode.session = undefined;
		}
		await mcpManager.disconnectAll();

		// Only emit agent_stopped if this session wasn't replaced by a new one.
		// When stopTask/stopAgent explicitly stops us, they already emitted
		// agent_stopped. Emitting again would create a stale event that appears
		// after the new session's orchestration_started.
		if (!sessionWasReplaced) {
			emitEvent(ctx, project.id, {
				type: "agent_stopped",
				taskId: nodeId,
				ts: Date.now(),
			});
		}
	}

	// ── Phase 2 of two-phase done() ──
	// Runs AFTER session cleanup (finally block). Session is now null, so any
	// deliverMessage triggered by our task_complete to parent will correctly see
	// session=null and launch a new agent if the parent sends a follow-up message.
	//
	// Before committing done, check for late messages that arrived during shutdown
	// (between queue.close in done() and session clear in finally). If found,
	// re-launch the agent to process them — done didn't actually complete.
	const isDoneExit =
		agentResult != null &&
		(agentResult.exitReason === "done_passed" ||
			agentResult.exitReason === "done_failed");
	if (isDoneExit && agentResult) {
		const currentNode = tracker.getTask(nodeId);
		if (currentNode) {
			// Check for late messages before committing Phase 2
			const eventStore = getEventStore(ctx, project.id);
			let hasLateMessages = false;
			if (!isRoot && eventStore.has(nodeId)) {
				await eventStore.flushSession(nodeId);
				const events = eventStore.readActive(nodeId);
				const unconsumed = findUnconsumedMessages(events);
				if (unconsumed.length > 0) {
					hasLateMessages = true;
				}
			}

			if (hasLateMessages) {
				// Late messages arrived — don't commit done. Re-launch agent to
				// process them. The agent will see the messages and decide again.
				ensureChildAgentRunning(ctx, project, tracker, nodeId).catch((e) => {
					console.warn(
						`[Phase 2] Re-launching ${nodeId} for late messages:`,
						e instanceof Error ? e.message : String(e),
					);
				});
			} else {
				// No late messages — commit done.
				const newStatus =
					agentResult.exitReason === "done_passed" ? "verify" : "failed";
				tracker.updateStatus(nodeId, newStatus);
				await tracker.save();
				broadcastTreeUpdate(ctx, project.id, tracker);

				// Deliver task_complete to task above (skip folders)
				const taskAbove = tracker.getTaskAbove(nodeId);
				if (taskAbove && !isRoot) {
					const completionMsg = createTaskComplete(
						nodeId,
						currentNode.title ?? "unknown",
						agentResult.exitReason === "done_passed",
						agentResult.doneSummary ?? "",
					);
					deliverMessage(ctx, project, taskAbove.id, completionMsg).catch(
						(e) => {
							console.warn(
								`[Phase 2] Failed to deliver task_complete to parent ${taskAbove.id}:`,
								e,
							);
						},
					);
				}

				// Write done_notified marker — crash-safe confirmation that Phase 2 completed.
				// On crash recovery, if this event exists, Phase 2 was already committed.
				emitEvent(ctx, project.id, {
					type: "done_notified",
					taskId: nodeId,
					status: newStatus,
					summary: agentResult.doneSummary ?? "",
					ts: Date.now(),
				});
			}
		}
	}

	// Resolve loop promise so stopTask/resetTask can detect loop exit.
	ctx.agentLoopPromises.delete(nodeId);
	resolveLoopPromise?.();
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
