import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "../agent-provider.ts";
import { DEFAULT_MODEL } from "../config.ts";
import { rollOldTraceIdDirs } from "../debug-snapshot.ts";
import {
	buildSessionRepair,
	type Event,
	findOrphanedBackgroundProcesses,
	findUnconsumedMessages,
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
	createWorkContext,
} from "../queue-message-factory.ts";
import {
	initResourceRegistry,
	registerSideEffects,
} from "../resource-registry.ts";
import { buildSystemPrompt, type SystemPrompt } from "../system-prompts.ts";
import type { TaskTracker } from "../task-tracker.ts";
import { slugify } from "../task-utils.ts";
import { createAgentAuth } from "../tool-auth.ts";
import { toToolDefinition } from "../tool-def.ts";
import { buildJsonTools, type ToolDefinition } from "../tool-definition.ts";
import { MCP_SERVER_NAME } from "../tool-names.ts";
import {
	buildBuiltinToolDefs,
	cleanupSessionBackgroundProcesses,
} from "../tools/index.ts";
import { type AgentResult, isTask, type TaskSession } from "../types.ts";
import { ulid } from "../ulid.ts";
import { buildWorkContextContent } from "../work-context.ts";
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
	projectDebugDir,
	resolveProjectConfig,
} from "./helpers.ts";

// All provider events flow through the emit() callback → emitEvent().
// No more AgentEvent→Event conversion layer.
// The emit() function in createOrchestratorTools handles agent_event
// wrappers from MCP tools (child agents forwarding events to parent).

/**
 * How many per-traceId debug-snapshot directories to retain per task.
 * Each run of `runAgentForNode` writes under its own traceId subdirectory;
 * we keep the N most recent so post-mortem drift diagnosis has at least
 * "current" and "previous run" available, with some slack for multiple
 * restarts in a row.
 */
const DEBUG_SNAPSHOT_KEEP_TRACE_DIRS = 10;

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

// prepareAgentMessage removed — context header replaced by work_context hook on enqueue.

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

	// Initialize resource registry with daemon context (idempotent)
	initResourceRegistry(ctx);
	registerSideEffects({
		emit: (projectId: string, event: Record<string, unknown>) => {
			const ts = (event.ts as number) || Date.now();
			// Auto-inject traceId from the target task's session if missing.
			// Tool handlers emit via R.emit and don't carry loopTraceId —
			// we look it up on the current session so the event can be
			// attributed to the run that produced it.
			const lookupTraceId = (taskId: unknown): string | undefined => {
				if (typeof taskId !== "string" || !taskId) return undefined;
				const tracker = ctx.trackers.get(projectId);
				return tracker?.getTask(taskId)?.session?.loopTraceId;
			};
			if (event.type === "agent_event") {
				const evtTaskId = (event.taskId as string) || "";
				const eventType = event.eventType as string;
				const { type: _t, taskId: _tid, eventType: _et, ...rest } = event;
				const existingTraceId = (rest as Record<string, unknown>).traceId;
				const traceId = existingTraceId ?? lookupTraceId(evtTaskId);
				emitEvent(ctx, projectId, {
					type: eventType,
					taskId: evtTaskId,
					ts,
					...rest,
					...(traceId ? { traceId } : {}),
				} as unknown as Event);
			} else {
				const existingTraceId = event.traceId;
				const traceId = existingTraceId ?? lookupTraceId(event.taskId);
				const base = event.ts ? event : { ...event, ts };
				const withIds = traceId ? { ...base, traceId } : base;
				emitEvent(ctx, projectId, withIds as unknown as Event);
			}
		},
		broadcastTree: (projectId: string) => {
			const tracker = ctx.trackers.get(projectId);
			if (tracker) broadcastTreeUpdate(ctx, projectId, tracker);
		},
		deliverMessage: async (
			projectId: string,
			nodeId: string,
			message: QueueMessage,
			deliverOpts?: { quiet?: boolean },
		) => {
			const proj = ctx.pm.get(projectId);
			if (!proj) throw new Error(`Project ${projectId} not found`);
			await deliverMessage(ctx, proj, nodeId, message, deliverOpts);
		},
		stopTask: (projectId: string, nodeId: string) =>
			stopTask(ctx, projectId, nodeId),
		awaitLoopExit: async (nodeId: string) => {
			const promise = ctx.agentLoopPromises.get(nodeId);
			if (promise) await promise;
		},
		injectMessageToProject: opts.orchestratorSystemPrompt
			? async (projectId: string, message: string) => {
					return handleInjectMessage(
						ctx,
						projectId,
						message,
						undefined,
						opts.orchestratorSystemPrompt,
					);
				}
			: async () => ({ ok: false, error: "Auto-launch not available" }),
	});

	// Create auth for this agent
	const auth = createAgentAuth(project.id, opts.currentTaskId, opts.tracker);

	const { toolDefs, hasRunningChildren, setMessages, setAllTools } =
		createOrchestratorTools(
			auth,
			project.id,
			opts.currentTaskId,
			effectiveCfg.selfBootstrap,
		);

	// Convert builtin ToolDefs to ToolDefinitions using the same auth
	const builtinDefs = buildBuiltinToolDefs();
	const builtinTools = builtinDefs.map((def) => toToolDefinition(def, auth));

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

	// Capture traceId BEFORE clearing sessions
	const rootTraceId = rootNode.session.loopTraceId;

	// Stop ALL agents (root + children) via session on tracker nodes.
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
	broadcast(ctx, projectId, {
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

	// Emit agent_end synchronously — no await needed.
	// runAgentForNode's finally checks wasReplaced and skips its own emit.
	emitEvent(ctx, projectId, {
		type: "agent_end",
		taskId: rootNodeId,
		reason: "stopped",
		traceId: rootTraceId,
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

	// Capture traceId BEFORE clearing session
	const stoppedTraceId = node.session.loopTraceId;

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

	// Await loop exit — ensures finally block (agent_end, MCP disconnect,
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

	// Emit agent_end synchronously — no await needed.
	// runAgentForNode's finally checks wasReplaced and skips its own emit.
	emitEvent(ctx, projectId, {
		type: "agent_end",
		taskId: nodeId,
		reason: "stopped",
		traceId: stoppedTraceId,
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

	// Preferred path: hand to the running agent's queue. queue.enqueue()
	// synchronously invokes the onPersist callback (bound in runAgentForNode
	// to emitEvent), so JSONL write + delivery are a single atomic step.
	// Skip when the launch lock is held — the agent is still reading JSONL,
	// so we fall through to the direct-write path and let findUnconsumedMessages
	// recover the message when the agent finishes booting.
	if (!ctx.launchingNodes.has(nodeId)) {
		const queue = tracker.getTask(nodeId)?.session?.queue;
		if (queue) {
			try {
				queue.enqueue(message);
				return "enqueued";
			} catch {
				// Queue was closed — fall through to direct persist/launch
			}
		}
	}

	// Agent is not running (or is mid-launch): no queue to persist through,
	// so write the message directly. findUnconsumedMessages will recover it
	// when the agent next starts, and auto-launch below picks up the slack
	// for idle tasks.
	emitEvent(ctx, project.id, {
		type: "message",
		id: message.id,
		taskId: nodeId,
		body: message,
		ts: message.ts,
	});
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

	broadcastTreeUpdate(ctx, project.id, tracker);

	// The real user/parent message is persisted to disk and will be delivered
	// via queue drain. work_context is injected by enqueue hook.
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

	// Generate a unique trace ID for this agent loop instance.
	// Stored on TaskSession so external emit paths (stopTask, tool handlers via
	// resource-registry) can look it up and auto-inject it. The provider loop's
	// emitWithTask also reads this to tag every event with the run's trace.
	// Enables detection of interleaved events from duplicate launches.
	const loopTraceId = ulid();
	try {
		// Compute depth from the tree
		const depth = computeDepth(tracker, nodeId);

		// Create the queue first — shared between MCP tools and runChildCore.
		// onPersist binds every queue.enqueue to a single JSONL write via
		// emitEvent. This is the ONE persistence path for queue messages:
		// deliverMessage, bash background_complete, MCP tree_change
		// notifyTargetNode, and REST compact all route through queue.enqueue
		// and therefore land in JSONL exactly once. JSONL-recovery paths use
		// `enqueue(msg, { replay: true })` to skip onPersist (the message is
		// already on disk from the pre-crash session).
		const childQueue = new MessageQueue({
			onPersist: (msg) => {
				// onPersist runs while THIS loop owns the queue — the persistence
				// act is attributable to this run, even if the message's semantic
				// origin is external (task_message, cross_project, etc.). Tag
				// with loopTraceId so downstream tools can correlate the JSONL
				// write to the exact run that performed it. The direct-write
				// fallback in deliverMessage (agent not running) intentionally
				// omits traceId — that path is genuinely external to any run.
				emitEvent(ctx, project.id, {
					type: "message",
					id: msg.id,
					taskId: nodeId,
					body: msg,
					ts: msg.ts,
					traceId: loopTraceId,
				});
			},
		});

		// Create and attach TaskSession to the node
		const abortController = new AbortController();
		const taskSession: TaskSession = {
			queue: childQueue,
			abortController,
			loopTraceId,
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

			// Synthesize background_complete messages for bg processes that
			// were killed by the restart. Append them to JSONL unconditionally
			// — the walker skips standalone `message` events with ids (they
			// materialize only when a messages_consumed event references them),
			// so writing them between a pending yield tool_call and its
			// eventual tool_result is safe. findUnconsumedMessages below will
			// enqueue them via replay so onPersist does not re-write them.
			const bgOrphans = findOrphanedBackgroundProcesses(activeEvents, nodeId);
			if (bgOrphans.length > 0) {
				await eventStore.appendBatch(nodeId, bgOrphans);
				activeEvents = [...activeEvents, ...bgOrphans];
			}

			// Recover unconsumed messages. These were already persisted to JSONL
			// by prior queue.enqueue calls (or just now by the bgOrphans append
			// above) — their `message` events are on disk. replay: true skips
			// onPersist so the recovery does not create byte-identical duplicates.
			const unconsumed = findUnconsumedMessages(activeEvents);
			for (const msg of unconsumed) {
				childQueue.enqueue(msg, { replay: true });
			}
		}

		// Wire before-first-message hook for work_context injection.
		// Always set the hook — handles both fresh sessions AND post-compact
		// re-arm (resetBeforeFirstMessage in provider-shared.ts compact flow).
		// NOTE: hook fires on first NON-REPLAY enqueue. Unconsumed messages above
		// are replayed (skip hook). The first real message (from deliverMessage after
		// lock release) triggers the hook. For fresh sessions where the trigger message
		// was already written to JSONL by deliverMessage (before runAgentForNode),
		// it arrives as replay above → hook fires on the NEXT non-replay message.
		// To ensure work_context is always injected for fresh sessions, we explicitly
		// enqueue it here if no work_context exists in JSONL yet.
		const hasWorkContext = activeEvents.some(
			(e) =>
				e.type === "message" &&
				e.body &&
				typeof e.body === "object" &&
				"source" in e.body &&
				(e.body as { source: string }).source === "work_context",
		);
		if (!hasWorkContext) {
			// Fresh session or first run without work_context — inject it now
			const content = buildWorkContextContent(agentCwd);
			if (content) {
				const workCtxMsg = createWorkContext(content);
				// Use regular enqueue (not replay) so it persists to JSONL
				childQueue.enqueue(workCtxMsg);
			}
		}
		// Set hook for future compact re-arm (resetBeforeFirstMessage in compact flow)
		childQueue.setBeforeFirstMessage(() => {
			const content = buildWorkContextContent(agentCwd);
			if (!content) return [];
			return [createWorkContext(content)];
		});
		// Mark as fired — we just handled injection above (or it was already in JSONL)
		childQueue.markBeforeFirstMessageFired();

		// Emit session_config if not already present in JSONL.
		const hasSessionConfig = activeEvents.some(
			(e) => e.type === "session_config",
		);
		if (!hasSessionConfig) {
			const jsonToolsForConfig = buildJsonTools(agentCtx.mcpToolDefs);
			const sp = (() => {
				if (isRoot && agentCtx.effectiveCfg.selfBootstrap) {
					return buildSystemPrompt({ selfBootstrap: true });
				}
				if (isRoot && opts?.orchestratorSystemPrompt) {
					return opts.orchestratorSystemPrompt;
				}
				return buildSystemPrompt();
			})();
			const configuredTtl = isRoot
				? agentCtx.effectiveCfg.cacheTtl.root
				: agentCtx.effectiveCfg.cacheTtl.child;
			const cacheTtl: "1h" | undefined =
				configuredTtl === "1h" ? "1h" : undefined;
			emitEvent(ctx, project.id, {
				type: "session_config",
				tools: jsonToolsForConfig,
				systemStable: sp.stable,
				systemVariable: sp.variable,
				...(cacheTtl ? { cacheTtl } : {}),
				taskId: nodeId,
				ts: Date.now(),
			});
		}

		// Release launch lock. deliverMessage skips direct queue delivery while
		// lock is held, so messages written during the lock window are in JSONL
		// and were recovered above by findUnconsumedMessages.
		// After lock release, messages go directly to the queue via deliverMessage.
		ctx.launchingNodes.delete(nodeId);

		// Build emit callback: emitEvent with taskId + traceId injected + streaming text tracking
		const emitWithTask = (event: Event) => {
			const withIds = { ...event, taskId: nodeId, traceId: loopTraceId };
			// Track streaming text for partial injection into batch events API
			if (event.type === "text_delta") {
				const existing = ctx.streamingText.get(nodeId) ?? "";
				ctx.streamingText.set(nodeId, existing + event.content);
			} else if (event.type === "assistant_text") {
				ctx.streamingText.delete(nodeId);
			}
			emitEvent(ctx, project.id, withIds as Event);
		};

		// Notify UI that this agent is now active
		emitEvent(ctx, project.id, {
			type: "agent_start",
			taskId: nodeId,
			resume: opts?.resume ?? eventStore.has(nodeId),
			provider: agentCtx.provider.name,
			model: effectiveModel ?? DEFAULT_MODEL,
			traceId: loopTraceId,
			ts: Date.now(),
		});

		// Cache TTL: configurable per role via three-layer config.
		// Defaults: root = "1h", child = "5m" (undefined = default ephemeral 5min).
		// On resume, inherit from stored session_config (fork copies this automatically).
		const configuredTtl = isRoot
			? agentCtx.effectiveCfg.cacheTtl.root
			: agentCtx.effectiveCfg.cacheTtl.child;
		const cacheTtl: "1h" | undefined =
			configuredTtl === "1h" ? "1h" : undefined;

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

		// Debug snapshot v2: per-traceId epoch.
		// Layout: <dataDir>/projects/<id>/debug/<taskId>/<traceId>/last.json
		// Each run writes to its own traceId dir → daemon restart preserves the
		// previous run's final snapshot automatically (it lives under the OLD
		// traceId). Roll old traceId dirs before the new one is created so the
		// cleanup never races with the active run's writes.
		const taskDebugDir = join(
			projectDebugDir(ctx.config.dataDir, project.id),
			nodeId,
		);
		rollOldTraceIdDirs(taskDebugDir, DEBUG_SNAPSHOT_KEEP_TRACE_DIRS);
		const debugSnapshotPath = join(taskDebugDir, loopTraceId, "last.json");

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
			debugSnapshotPath,

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

		// Cost tracking (was in orchestration_completed — now just tracker)
		// tracker.updateCost already called above.

		await tracker.save();
		broadcastTreeUpdate(ctx, project.id, tracker);
	} catch (e) {
		// Check if our session was replaced (stopTask/stopAgent already cleaned up).
		// If so, suppress error events — they'd be stale leaks from an old session.
		const catchNode = tracker.getTask(nodeId);
		const catchWasReplaced =
			!catchNode?.session || catchNode.session !== ownSession;
		if (!catchWasReplaced) {
			// Error = interrupted. Status stays in_progress — agent is resumable.
			const errorMsg = e instanceof Error ? e.message : String(e);
			emitEvent(ctx, project.id, {
				type: "error",
				taskId: nodeId,
				message: `Agent error: ${errorMsg}`,
				traceId: loopTraceId,
				ts: Date.now(),
			});
		}
		// If wasReplaced: stopAgent/stopTask already emitted agent_end(stopped).
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
		const notReplaced =
			finalNode?.session != null && finalNode.session === ownSession;
		if (notReplaced && finalNode?.session) {
			cleanupSessionBackgroundProcesses(finalNode.session.backgroundProcesses);
			finalNode.session = undefined;
		}
		await mcpManager.disconnectAll();

		if (notReplaced) {
			emitEvent(ctx, project.id, {
				type: "agent_end",
				taskId: nodeId,
				reason: "stopped",
				traceId: loopTraceId,
				ts: Date.now(),
			});
		}
	}

	// ── Phase 2 of two-phase done() ──
	// Runs AFTER session cleanup (finally block). Session is now null.
	const isDoneExit =
		agentResult != null &&
		(agentResult.exitReason === "done_passed" ||
			agentResult.exitReason === "done_failed");
	if (isDoneExit && agentResult) {
		const currentNode = tracker.getTask(nodeId);
		if (currentNode) {
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
				ensureChildAgentRunning(ctx, project, tracker, nodeId).catch(
					(e) => {
						console.warn(
							`[Phase 2] Re-launching ${nodeId} for late messages:`,
							e instanceof Error ? e.message : String(e),
						);
					},
				);
			} else {
				const newStatus =
					agentResult.exitReason === "done_passed" ? "verify" : "failed";
				tracker.updateStatus(nodeId, newStatus);
				await tracker.save();
				broadcastTreeUpdate(ctx, project.id, tracker);

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

				emitEvent(ctx, project.id, {
					type: "done_notified",
					taskId: nodeId,
					status: newStatus,
					summary: agentResult.doneSummary ?? "",
					traceId: loopTraceId,
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

	// No header needed — work_context is injected by enqueue hook on fresh sessions.
	const msg = createUserMessage(message, { images });

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
