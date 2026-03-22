/**
 * MCP tool definitions and handlers for orchestration tools.
 *
 * Extracted from agent-tools.ts for maintainability.
 * Contains createOrchestratorTools() and all tool definitions
 * (create_task, update_task, send_message_to_child, yield, done, etc.).
 */

import { z } from "zod";
import type { AgentProvider } from "./agent-provider.ts";
import {
	formatQueueMessage,
	getDescendantIds,
	isDescendantOf,
	resolveColor,
	slugify,
} from "./agent-tools.ts";

import {
	globalAgentQueues,
	type MessageQueue,
	type QueueMessage,
} from "./message-queue.ts";
import { clearPersistedMessages } from "./persistent-queue.ts";
import type { ProjectManager } from "./project-manager.ts";
import type { TaskTracker } from "./task-tracker.ts";
import { type ToolDefinition, tool } from "./tool-definition.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

/**
 * Check if the git working tree is clean (no uncommitted changes).
 * Worktrees branch from the current HEAD, so dirty state would be lost.
 */
async function isGitClean(projectPath: string): Promise<{
	clean: boolean;
	message: string;
}> {
	const proc = Bun.spawn(["git", "status", "--porcelain"], {
		cwd: projectPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	const output = (await new Response(proc.stdout).text()).trim();
	if (!output) {
		return { clean: true, message: "" };
	}
	const lines = output.split("\n").filter((l) => l.trim());
	return {
		clean: false,
		message: `Working tree has ${lines.length} uncommitted change(s):\n${output}\n\nCommit or stash changes before spawning tasks.`,
	};
}

export interface OrchestratorToolsDeps {
	tracker: TaskTracker;
	provider: AgentProvider;
	worktrees: WorktreeManager;
	/** Working directory for this agent (main repo or worktree). */
	projectPath: string;
	/** Main repo root — always the same, used for git operations. */
	repoPath: string;
	/** Current task ID — null for top-level orchestrator (project level). */
	currentTaskId?: string | null;
	/** Recursion depth (0 = top-level orchestrator). Max depth limits MCP tool injection. */
	depth?: number;
	/** Optional callback for broadcasting task events (e.g., to SSE clients). */
	onTaskEvent?: (event: Record<string, unknown>) => void;
	/** Optional callback to broadcast tree updates to SSE clients after task mutations. */
	broadcastTreeUpdate?: () => void;
	/** Model for child agent execution (defaults to provider's default). */
	childModel?: string;
	/** MessageQueue for the parent agent session (for fire-and-forget results). */
	queue?: MessageQueue;
	/**
	 * Dynamic parent queue lookup — called at invocation time, not captured at launch.
	 * Returns the nearest ancestor's queue, or undefined for top-level orchestrator.
	 */
	getParentQueue?: () => MessageQueue | undefined;
	/** Default budget per task from project config. undefined = unlimited. */
	defaultBudgetUsd?: number;
	/** Timeout for clarify() responses in ms. undefined = wait forever. */
	clarifyTimeoutMs?: number;
	/** Maximum recursive depth for spawning child agents. Defaults to 3. */
	maxDepth?: number;
	/** Project manager for cross-project communication. Only needed at depth 0. */
	projectManager?: ProjectManager;
	/**
	 * Check if a project has an active agent running. Only needed at depth 0.
	 * Uses globalAgentQueues to check if root node has a queue.
	 */
	isProjectActive?: (projectId: string) => boolean;
	/**
	 * Find the root queue for a project by looking up its rootNodeId in globalAgentQueues.
	 * Only needed at depth 0 for cross-project message delivery.
	 */
	getProjectRootQueue?: (projectId: string) => MessageQueue | undefined;
	/** Current project ID — used as sender identity for cross-project messages. */
	currentProjectId?: string;
	/** Clear session JSONL data for a task. Used by reset/delete to clean up event history. */
	clearSession?: (taskId: string) => void;
	/** Data directory root (~/.opengraft). Used for persistent message queue. */
	dataDir?: string;
	/**
	 * Close the agent's own queue. Used by done() to unblock waitForQueueMessages()
	 * without emitting task_completed. Only set for child agents (depth > 0).
	 */
	closeQueue?: () => void;
	/**
	 * Deliver a message to a task: persist → enqueue (if running) → launch (if not).
	 * Daemon provides this via the deliverMessage function in agent-lifecycle.ts.
	 */
	deliverMessage?: (nodeId: string, message: QueueMessage) => Promise<void>;
	/**
	 * Inject a message into another project, auto-launching agent if needed.
	 * Wraps handleInjectMessage from agent-lifecycle.ts. Only needed at depth 0.
	 */
	injectMessageToProject?: (
		projectId: string,
		message: string,
	) => Promise<{ ok: boolean; error?: string }>;
}

/** Tracks accumulated costs from all child agent executions. */
export class CostAccumulator {
	private _totalCost = 0;
	private _totalTurns = 0;
	private _taskCount = 0;

	add(costUsd: number | undefined, turns: number | undefined): void {
		if (costUsd) this._totalCost += costUsd;
		if (turns) this._totalTurns += turns;
		this._taskCount++;
	}

	get totalCostUsd(): number {
		return this._totalCost;
	}
	get totalTurns(): number {
		return this._totalTurns;
	}
	get taskCount(): number {
		return this._taskCount;
	}
}

/** Result of createOrchestratorTools — raw tool definitions for provider forwarding. */
export interface OrchestratorToolsResult {
	/** Raw tool definitions for provider forwarding. */
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic is not narrowable here
	toolDefs: ToolDefinition<any>[];
	/** Returns true if this agent has running children (checked via globalAgentQueues). */
	hasRunningChildren?: () => boolean;
}

/**
 * Create orchestrator tools for the main agent.
 * Returns both an MCP server (for Claude Code provider) and raw tool definitions
 * (for AnthropicCompatibleProvider to forward as Anthropic API tools).
 */
export function createOrchestratorTools(
	deps: OrchestratorToolsDeps,
): OrchestratorToolsResult {
	const { tracker, worktrees, projectPath, onTaskEvent, broadcastTreeUpdate } =
		deps;
	const currentTaskId = deps.currentTaskId ?? null;
	const emit = (event: Record<string, unknown>) => onTaskEvent?.(event);
	/** Count of outstanding clarify() calls that have not yet received a clarify_response. */
	let pendingClarifications = 0;

	/**
	 * Shared yield logic: wait for messages on the queue, handle compact signals,
	 * clarify timeouts, emit idle/active events, and return formatted result.
	 * Used by both yield() and done() tools.
	 * Returns null if no queue is available.
	 */
	async function waitForQueueMessages(): Promise<{
		content: Array<
			| { type: "text"; text: string }
			| { type: "image"; data: string; mimeType: string }
		>;
		isError?: boolean;
		_consumedMessageIds?: string[];
		_formattedQueueMessages?: string;
		_pending?: {
			runningChildren: Array<{ id: string; title: string }>;
			pendingClarifications: number;
		};
	} | null> {
		if (!deps.queue) return null;
		try {
			let all: QueueMessage[];

			while (true) {
				if (currentTaskId) {
					deps.queue.idle = true;
					emit({ type: "agent_idle", taskId: currentTaskId });
				}

				const timeoutMs =
					pendingClarifications > 0 ? deps.clarifyTimeoutMs : undefined;
				const result = await deps.queue.waitForMessage(timeoutMs);

				if (result === "timeout") {
					const timeoutMsg = `<clarify_timeout duration="${timeoutMs}ms">No response received. Proceed with your best judgement.</clarify_timeout>`;
					emit({
						type: "clarification_timeout",
						taskId: currentTaskId ?? undefined,
						timeoutMs,
					});
					const synthesized: QueueMessage[] = Array.from(
						{ length: pendingClarifications },
						() => ({
							source: "clarify_response" as const,
							answer: timeoutMsg,
						}),
					);
					pendingClarifications = 0;
					all = [...synthesized, ...deps.queue.drainMerged()];
				} else {
					const rest = deps.queue.drainMerged();
					all = [result, ...rest];
					for (const msg of all) {
						if (msg.source === "clarify_response") {
							pendingClarifications = Math.max(0, pendingClarifications - 1);
						}
					}
				}

				const compactMsgs = all.filter((m) => m.source === "compact");
				all = all.filter((m) => m.source !== "compact");
				if (compactMsgs.length > 0) {
					for (const cm of compactMsgs) {
						deps.queue.enqueue(cm);
					}
					break;
				}
				if (all.length > 0) break;
			}

			if (currentTaskId) {
				deps.queue.idle = false;
				emit({ type: "agent_active", taskId: currentTaskId });
			}

			const formatted = all.map(formatQueueMessage).join("\n");

			const completedIds = new Set(
				all
					.filter(
						(m): m is Extract<QueueMessage, { source: "child_complete" }> =>
							m.source === "child_complete",
					)
					.map((m) => m.taskId),
			);
			const myDescendants = currentTaskId
				? getDescendantIds(tracker, currentTaskId)
				: [];
			const runningChildren = myDescendants.filter(
				(id) => globalAgentQueues.has(id) && !completedIds.has(id),
			);
			// Build structured pending data
			const runningChildrenData = runningChildren.map((id) => ({
				id,
				title: tracker.get(id)?.title ?? id,
			}));
			const pendingData = {
				runningChildren: runningChildrenData,
				pendingClarifications,
			};

			const runningChildrenText =
				runningChildrenData.length > 0
					? runningChildrenData.map((c) => `"${c.title}" (${c.id})`).join(", ")
					: "none";
			const clarifyText =
				pendingClarifications > 0 ? String(pendingClarifications) : "none";
			const pendingSection = [
				"",
				"## Pending",
				`- Running children: ${runningChildrenText}`,
				`- Pending clarifications: ${clarifyText}`,
			].join("\n");

			const imageBlocks: Array<{
				type: "image";
				data: string;
				mimeType: string;
			}> = [];
			for (const msg of all) {
				if (msg.source === "user" && msg.images) {
					for (const img of msg.images) {
						imageBlocks.push({
							type: "image",
							data: img.base64,
							mimeType: img.mediaType,
						});
					}
				}
			}

			// Separate user messages (already persisted at send time) from queue messages
			// that need to flow through the provider's emit path for SSE broadcast + persistence.
			const userConsumedIds: string[] = [];
			const queueMessages: QueueMessage[] = [];
			for (const msg of all) {
				if (msg.source === "user" && msg.id) {
					userConsumedIds.push(msg.id);
				} else {
					queueMessages.push(msg);
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: pendingSection.trimStart(),
					},
					...imageBlocks,
				],
				...(userConsumedIds.length > 0
					? { _consumedMessageIds: userConsumedIds }
					: {}),
				...(queueMessages.length > 0
					? { _consumedQueueMessages: queueMessages }
					: {}),
				...(formatted ? { _formattedQueueMessages: formatted } : {}),
				_pending: pendingData,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return {
				content: [
					{
						type: "text" as const,
						text: `Queue error: ${message}`,
					},
				],
				isError: true,
			};
		}
	}

	const toolDefs = [
		tool(
			"get_tree",
			"Get the current task tree. Returns all nodes with their status, branch, and hierarchy.",
			{ format: z.enum(["flat", "tree"]).optional().default("flat") },
			async () => {
				const nodes = tracker.allNodes();
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ nodes }, null, 2),
						},
					],
				};
			},
		),

		tool(
			"create_task",
			"Create a new task. If parentId is provided, creates a child under that parent. " +
				"If omitted, creates a child of YOUR current task (or top-level if you are the root orchestrator). " +
				"IMPORTANT: Sibling tasks will run in PARALLEL on separate branches. " +
				"Each sibling must work on DIFFERENT files/modules to avoid merge conflicts.",
			{
				title: z.string().describe("Short title for the task"),
				description: z
					.string()
					.describe("Detailed description of what the task should accomplish"),
				parentId: z
					.string()
					.optional()
					.describe(
						"Parent task ID. Omit to create a child of your current task.",
					),
				draft: z
					.boolean()
					.optional()
					.describe(
						"If true, creates the task as a draft. Draft tasks can be edited but not executed.",
					),
				color: z
					.string()
					.optional()
					.describe(
						"Optional color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex like '#ff5733'). " +
							"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
					),
			},
			async (args) => {
				try {
					// Auto-parent: if no parentId provided, default to current agent's task
					const effectiveParentId = args.parentId ?? currentTaskId ?? undefined;

					// Scope validation: agents can only create tasks under themselves or their descendants
					if (
						effectiveParentId &&
						currentTaskId !== null &&
						effectiveParentId !== currentTaskId &&
						!isDescendantOf(tracker, effectiveParentId, currentTaskId)
					) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Cannot create task under ${effectiveParentId}: not your task or descendant`,
								},
							],
							isError: true,
						};
					}

					const opts: {
						budgetUsd?: number;
						draft?: boolean;
						editedBy: "agent";
					} = { editedBy: "agent" };
					if (deps.defaultBudgetUsd) opts.budgetUsd = deps.defaultBudgetUsd;
					if (args.draft) opts.draft = true;
					const node = effectiveParentId
						? tracker.addChild(
								effectiveParentId,
								args.title,
								args.description,
								opts,
							)
						: tracker.addTask(args.title, args.description, opts);
					if (args.color) {
						tracker.updateColor(node.id, resolveColor(args.color), "agent");
					}
					await tracker.save();
					broadcastTreeUpdate?.();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(node, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text" as const, text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		),

		tool(
			"update_task",
			"Update a task node. All fields except taskId are optional — provide only the fields you want to change.",
			{
				taskId: z.string().describe("Task node ID"),
				status: z
					.enum([
						"draft",
						"pending",
						"in_progress",
						"testing",
						"passed",
						"failed",
						"closed",
					])
					.optional()
					.describe("New status"),
				title: z.string().optional().describe("New title"),
				description: z.string().optional().describe("New description"),
				draft: z
					.boolean()
					.optional()
					.describe(
						"Set draft flag. true = status becomes 'draft', false = status becomes 'pending'.",
					),
				parentId: z
					.string()
					.optional()
					.describe(
						"New parent task ID. Moves the task under this parent (reparent).",
					),
				color: z
					.string()
					.optional()
					.describe(
						"Color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex). " +
							"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
					),
			},
			async (args) => {
				try {
					if (args.parentId !== undefined) {
						// Scope validation: agent can only reparent tasks under itself or its descendants
						if (
							currentTaskId !== null &&
							args.taskId !== currentTaskId &&
							!isDescendantOf(tracker, args.taskId, currentTaskId)
						) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Cannot reparent ${args.taskId}: not your task or descendant`,
									},
								],
								isError: true,
							};
						}
						if (
							currentTaskId !== null &&
							args.parentId !== currentTaskId &&
							!isDescendantOf(tracker, args.parentId, currentTaskId)
						) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Cannot reparent under ${args.parentId}: not your task or descendant`,
									},
								],
								isError: true,
							};
						}
						tracker.reparent(args.taskId, args.parentId);
					}
					if (args.status !== undefined) {
						tracker.updateStatus(args.taskId, args.status, "agent");
					}
					if (args.title !== undefined) {
						tracker.updateTitle(args.taskId, args.title, "agent");
					}
					if (args.description !== undefined) {
						tracker.updateDescription(args.taskId, args.description, "agent");
					}
					if (args.draft !== undefined) {
						tracker.updateStatus(
							args.taskId,
							args.draft ? "draft" : "pending",
							"agent",
						);
					}
					if (args.color !== undefined) {
						tracker.updateColor(
							args.taskId,
							args.color ? resolveColor(args.color) : null,
							"agent",
						);
					}
					await tracker.save();
					broadcastTreeUpdate?.();
					const node = tracker.get(args.taskId);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(node, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text" as const, text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		),

		tool(
			"yield",
			"Suspend execution and wait for messages (child completions, user messages, etc.). " +
				"Call this when you have spawned tasks and are waiting for results. " +
				"Returns all accumulated messages plus a ## Pending summary section. " +
				"Zero token burn while waiting.",
			{},
			async () => {
				const result = await waitForQueueMessages();
				if (!result) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No message queue available",
							},
						],
						isError: true,
					};
				}
				return result;
			},
		),

		tool(
			"send_message_to_child",
			"Send a message to a child task — starts it if not running. " +
				"If the task has no worktree, one is auto-created. " +
				"If no agent is running, one is launched with the message as the prompt. " +
				"If the agent is already running, the message is delivered to its queue. " +
				"Call once per task for parallel launches.",
			{
				taskId: z.string().describe("ID of the child task to message or start"),
				message: z
					.string()
					.describe(
						"Message content — becomes the prompt for new tasks, or instructions for running ones",
					),
				requestReply: z
					.boolean()
					.optional()
					.describe(
						"If true, signals to the child that a reply (via report_to_parent) is expected.",
					),
			},
			async (args) => {
				// Validate: task exists and is a descendant
				const node = tracker.get(args.taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Task "${args.taskId}" not found.`,
							},
						],
						isError: true,
					};
				}
				if (currentTaskId !== null) {
					// Non-root agent: only direct children allowed
					if (node.parentId !== currentTaskId) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: Task "${args.taskId}" is not your direct child.`,
								},
							],
							isError: true,
						};
					}
				} else {
					// Root orchestrator: only top-level tasks (children of root node)
					if (node.parentId !== tracker.rootNodeId && node.parentId !== null) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: Task "${args.taskId}" is not your direct child.`,
								},
							],
							isError: true,
						};
					}
				}
				if (node.status === "draft") {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Task "${node.title}" (${args.taskId}) is a draft and cannot be started. Remove draft status first.`,
							},
						],
						isError: true,
					};
				}

				try {
					// Create worktree if needed (requires clean working tree)
					if (!node.worktreePath) {
						const gitCheck = await isGitClean(projectPath);
						if (!gitCheck.clean) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Error: ${gitCheck.message}`,
									},
								],
								isError: true,
							};
						}
						const currentNode = currentTaskId
							? tracker.get(currentTaskId)
							: undefined;
						const baseBranch = currentNode?.branch ?? undefined;
						const slug = slugify(node.title);
						const wt = await worktrees.create(node.id, slug, baseBranch);
						tracker.assignWorktree(node.id, wt.branch, wt.path);
					}

					// Build header with task context for child startup
					// Header includes task description + git context — the "what to do" part
					// Content is the parent's specific message — the "instructions" part
					const headerParts: string[] = [];
					headerParts.push(`## Task: ${node.title}`);
					headerParts.push(`Task ID: \`${node.id}\``);
					if (node.description) headerParts.push(node.description);
					if (node.branch) {
						headerParts.push(
							`\n## Git Context`,
							`You are on branch: \`${node.branch}\``,
							`Your working directory is already set to \`${node.worktreePath ?? "unknown"}\` — do NOT cd to it.`,
							`Do NOT switch branches. All commits go on \`${node.branch}\`.`,
						);
					}
					const header =
						headerParts.length > 0 ? headerParts.join("\n") : undefined;

					// Deliver message via unified path: persist → enqueue/launch
					// The message is NOT included in the launch prompt — it arrives
					// via queue drain of persisted messages (exactly-once delivery).
					const queueMessage: QueueMessage = {
						source: "parent_update",
						content: args.message,
						...(args.requestReply ? { requestReply: true } : {}),
						...(header ? { header } : {}),
					};

					if (deps.deliverMessage) {
						await deps.deliverMessage(args.taskId, queueMessage);
					} else {
						// Fallback for non-daemon contexts (tests without full daemon):
						// direct queue delivery only
						const existingQueue = globalAgentQueues.get(args.taskId);
						if (existingQueue) {
							existingQueue.enqueue(queueMessage);
						}
					}

					const wasRunning = globalAgentQueues.has(args.taskId);
					return {
						content: [
							{
								type: "text" as const,
								text: wasRunning
									? `Message sent to running child "${node.title}" (${args.taskId})`
									: `Started child "${node.title}" (${args.taskId}) on branch ${node.branch}`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error starting child: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"close_task",
			"Clean up a child task's worktree and branch to reclaim disk space. " +
				"Node and session are preserved — status set to 'closed'. " +
				"Call this AFTER you have already merged the child's branch yourself. " +
				"Use for merged tasks or deferred tasks where you want to free resources.",
			{
				taskId: z.string().describe("ID of the task to close"),
			},
			async (args) => {
				const node = tracker.get(args.taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: Task not found",
							},
						],
						isError: true,
					};
				}

				try {
					// Close running agent if active
					// Delete from registry first so callers see "no queue" not "closed queue"
					const activeQueueClose = globalAgentQueues.get(args.taskId);
					if (activeQueueClose) {
						globalAgentQueues.delete(args.taskId);
						activeQueueClose.close();
					}

					// Clean up worktree + branch if they exist
					if (node.worktreePath && node.branch) {
						const slug = slugify(node.title);
						await worktrees.remove(node.id, slug);
						node.worktreePath = null;
						node.branch = null;
						node.updatedAt = new Date().toISOString();
					}

					tracker.updateStatus(node.id, "closed");
					await tracker.save();
					broadcastTreeUpdate?.();

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										closed: true,
										taskId: node.id,
										title: node.title,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"delete_task",
			"Fully remove a child task — deletes worktree, session file, and task node from the tree. " +
				"WARNING: Also deletes ALL children recursively. Verify all children are completed and merged before deleting. " +
				"Use for abandoned tasks you no longer need.",
			{
				taskId: z.string().describe("ID of the task to delete"),
			},
			async (args) => {
				const node = tracker.get(args.taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: Task not found",
							},
						],
						isError: true,
					};
				}

				try {
					// Close running agent if active
					// Delete from registry first so callers see "no queue" not "closed queue"
					const activeQueueDelete = globalAgentQueues.get(args.taskId);
					if (activeQueueDelete) {
						globalAgentQueues.delete(args.taskId);
						activeQueueDelete.close();
					}

					// Clean up worktree + branch if they exist
					if (node.worktreePath && node.branch) {
						const slug = slugify(node.title);
						await worktrees.remove(node.id, slug);
					}

					// Delete event JSONL files
					deps.clearSession?.(node.id);

					// Clear persisted messages for this task and all descendants
					if (deps.dataDir && deps.currentProjectId) {
						const dd = deps.dataDir;
						const pid = deps.currentProjectId;
						const collectIds = (id: string): string[] => {
							const n = tracker.get(id);
							if (!n) return [];
							return [id, ...n.children.flatMap((cid) => collectIds(cid))];
						};
						const allIds = collectIds(node.id);
						await Promise.all(
							allIds.map((id) => clearPersistedMessages(dd, pid, id)),
						);
					}

					// Remove node from tree
					tracker.remove(node.id);
					await tracker.save();
					broadcastTreeUpdate?.();

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										deleted: true,
										taskId: node.id,
										title: node.title,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"reset_task",
			"Reset a child task for a fresh start — removes worktree and session file but keeps the node. " +
				"Sets status to pending. Use when you want to retry with a different approach.",
			{
				taskId: z.string().describe("ID of the task to reset"),
			},
			async (args) => {
				const node = tracker.get(args.taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: Task not found",
							},
						],
						isError: true,
					};
				}

				try {
					// Close running agent if active
					// Delete from registry first so callers see "no queue" not "closed queue"
					const activeQueueReset = globalAgentQueues.get(args.taskId);
					if (activeQueueReset) {
						globalAgentQueues.delete(args.taskId);
						activeQueueReset.close();
					}

					// Clean up worktree + branch if they exist
					if (node.worktreePath && node.branch) {
						const slug = slugify(node.title);
						await worktrees.remove(node.id, slug);
						node.worktreePath = null;
						node.branch = null;
					}

					// Delete event JSONL files
					deps.clearSession?.(node.id);

					// Clear persisted messages (follows session lifecycle)
					if (deps.dataDir && deps.currentProjectId) {
						await clearPersistedMessages(
							deps.dataDir,
							deps.currentProjectId,
							node.id,
						);
					}

					tracker.updateStatus(node.id, "pending");
					await tracker.save();
					broadcastTreeUpdate?.();

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										reset: true,
										taskId: node.id,
										title: node.title,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"clarify",
			"Ask a clarification question and send it to the user. " +
				"Returns immediately — you can continue doing other work that doesn't need the answer, " +
				"then call yield() when ready to wait for the clarify_response. " +
				"Only use this for genuine ambiguities that could lead to wasted work.",
			{
				question: z
					.string()
					.describe(
						"The clarification question to ask the user or parent orchestrator",
					),
			},
			async (args) => {
				const taskId = currentTaskId ?? "orchestrator";

				// Track this as a pending clarification — decremented in yield() when clarify_response arrives
				pendingClarifications++;

				emit({
					type: "clarification_requested",
					taskId,
					question: args.question,
					// Title is the first line; body is the rest (if multi-line)
					...(args.question.includes("\n")
						? {
								title: args.question.split("\n")[0],
								body: args.question.split("\n").slice(1).join("\n").trim(),
							}
						: { title: args.question }),
				});

				return {
					content: [
						{
							type: "text" as const,
							text: "Question sent. You can continue working on other things that don't need the answer, then call yield() when ready to receive the clarify_response.",
						},
					],
				};
			},
		),

		tool(
			"report_to_parent",
			"Send a progress update or status message to your parent agent. " +
				"Non-blocking: returns immediately. " +
				"The parent receives this as a child_report message when it calls yield(). " +
				"Use this to keep the parent informed about important intermediate progress, " +
				"blockers, or results without waiting for acknowledgement.",
			{
				title: z
					.string()
					.describe(
						"Short summary of the report (shown as card title in parent's activity log)",
					),
				message: z
					.string()
					.describe("The detailed message content to send to the parent agent"),
				requestReply: z
					.boolean()
					.optional()
					.describe(
						"If true, signals to the parent that a reply (via send_message_to_child) is expected.",
					),
			},
			async (args) => {
				// Dynamic parent queue lookup at invocation time
				const parentQueue = deps.getParentQueue?.();
				if (!parentQueue) {
					// No parent queue — silently no-op (top-level orchestrator has no parent)
					return {
						content: [
							{
								type: "text" as const,
								text: "No parent agent to report to (you are the top-level orchestrator). Message dropped.",
							},
						],
					};
				}

				const node = currentTaskId ? tracker.get(currentTaskId) : null;
				const taskTitle = node?.title ?? "unknown";

				try {
					parentQueue.enqueue({
						source: "child_report",
						taskId: currentTaskId ?? "unknown",
						title: taskTitle,
						summary: args.title,
						content: args.message,
						...(args.requestReply ? { requestReply: true } : {}),
					});
					return {
						content: [
							{
								type: "text" as const,
								text: "Message reported to parent agent.",
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error reporting to parent: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"reorder_tasks",
			"Reorder children of a task node. The children array must contain exactly the same task IDs as the current children, just in a different order.",
			{
				nodeId: z.string().describe("Parent task ID whose children to reorder"),
				children: z
					.array(z.string())
					.describe("Ordered list of child task IDs"),
			},
			async (args) => {
				try {
					// Scope validation: must be own task or descendant
					if (
						currentTaskId !== null &&
						args.nodeId !== currentTaskId &&
						!isDescendantOf(tracker, args.nodeId, currentTaskId)
					) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Cannot reorder children of ${args.nodeId}: not your task or descendant`,
								},
							],
							isError: true,
						};
					}
					tracker.reorderChildren(args.nodeId, args.children);
					await tracker.save();
					broadcastTreeUpdate?.();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										reordered: true,
										nodeId: args.nodeId,
										children: args.children,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text" as const, text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		),

		tool(
			"list_projects",
			"List all registered projects with their IDs, names, and paths. " +
				"Use this to discover other projects before sending cross-project messages.",
			{},
			async () => {
				if (!deps.projectManager) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}
				const projects = deps.projectManager.list().map((p) => ({
					id: p.id,
					name: p.name,
					path: p.path,
					hasActiveAgent: deps.isProjectActive?.(p.id) ?? false,
				}));
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(projects, null, 2),
						},
					],
				};
			},
		),

		tool(
			"send_message_to_project",
			"Send a message to the orchestrator of another project. " +
				"The message appears in the target project's orchestrator queue as a cross_project message. " +
				"If the target project has no active agent, one is auto-launched with the message as the initial prompt.",
			{
				projectId: z.string().describe("ID of the target project"),
				message: z.string().describe("Message content to send"),
			},
			async (args) => {
				if (!deps.projectManager || !deps.getProjectRootQueue) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}

				const targetProject = deps.projectManager.get(args.projectId);
				if (!targetProject) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Project "${args.projectId}" not found.`,
							},
						],
						isError: true,
					};
				}

				// Determine sender identity
				const senderProject = deps.currentProjectId
					? deps.projectManager.get(deps.currentProjectId)
					: undefined;
				const fromProjectId = deps.currentProjectId ?? "unknown";
				const fromProjectName = senderProject?.name ?? "unknown";

				// Try direct enqueue if target agent is already running
				const targetQueue = deps.getProjectRootQueue(args.projectId);
				if (targetQueue) {
					try {
						targetQueue.enqueue({
							source: "cross_project",
							fromProjectId,
							fromProjectName,
							content: args.message,
						});
						return {
							content: [
								{
									type: "text" as const,
									text: `Message sent to project "${targetProject.name}" (${args.projectId}).`,
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [
								{
									type: "text" as const,
									text: `Error sending message: ${message}`,
								},
							],
							isError: true,
						};
					}
				}

				// Agent not running — auto-launch via injectMessageToProject
				if (!deps.injectMessageToProject) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: No active agent running for project "${targetProject.name}" (${args.projectId}), and auto-launch is not available.`,
							},
						],
						isError: true,
					};
				}

				try {
					// Prepend sender identity so the target agent knows who sent the message
					const prefixedMessage = `[Cross-project message from "${fromProjectName}" (${fromProjectId})]\n\n${args.message}`;
					const result = await deps.injectMessageToProject(
						args.projectId,
						prefixedMessage,
					);
					if (!result.ok) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${result.error ?? "Failed to launch agent for target project."}`,
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text" as const,
								text: `Message sent to project "${targetProject.name}" (${args.projectId}). Agent was not running and has been auto-launched.`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error sending message: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"done",
			"Signal that you have finished working on your task. " +
				"Call this when you are done — either passed (task completed successfully) or failed (you cannot continue). " +
				"This is the proper way to exit. Do NOT just stop responding — always call done().",
			{
				status: z
					.enum(["passed", "failed"])
					.describe("Whether the task passed or failed"),
				summary: z
					.string()
					.describe(
						"Brief summary of what was accomplished (if passed) or what went wrong (if failed)",
					),
			},
			async (args) => {
				// Update task status in the tree
				if (currentTaskId) {
					tracker.updateStatus(
						currentTaskId,
						args.status === "passed" ? "passed" : "failed",
					);
					await tracker.save();
					broadcastTreeUpdate?.();
				}

				// Deliver child_complete message directly to parent queue (child agents only).
				// This is the canonical delivery — runChildAgentInBackground skips it when done() was called.
				const depth = deps.depth ?? 0;
				if (currentTaskId && depth > 0) {
					const node = tracker.get(currentTaskId);
					const completionMsg: QueueMessage = {
						source: "child_complete",
						taskId: currentTaskId,
						title: node?.title ?? "unknown",
						success: args.status === "passed",
						output: args.summary.slice(0, 2000),
					};
					// Try direct enqueue to parent's queue first
					const parentQueue = deps.getParentQueue?.();
					if (parentQueue) {
						try {
							parentQueue.enqueue(completionMsg);
						} catch {
							// Queue closed — persist via deliverMessage fallback below
						}
					}
					// Always persist to immediate parent for eventual resumption
					// (parent may not be running, or may be a different ancestor)
					if (node?.parentId && deps.deliverMessage) {
						const directParentQueue = globalAgentQueues.get(node.parentId);
						// Only persist if we didn't already enqueue to the direct parent
						if (!directParentQueue || directParentQueue !== parentQueue) {
							deps.deliverMessage(node.parentId, completionMsg).catch(() => {});
						}
					}
				}

				// Close queue for child agents — unblocks waitForQueueMessages() below
				// which will reject immediately since queue is closed.
				// Root agents don't close here — they block on waitForQueueMessages() normally.
				deps.closeQueue?.();

				// Enter implicit yield — wait for wake messages (e.g. parent resume).
				// This prevents the provider from making another API call after done(),
				// which would waste tokens and create confusing behavior.
				const wakeResult = await waitForQueueMessages();
				if (wakeResult && !wakeResult.isError) {
					// Prepend context so the agent knows it previously completed
					const firstBlock = wakeResult.content[0];
					if (firstBlock && firstBlock.type === "text") {
						firstBlock.text = `You previously called done(${args.status}). New messages woke you up:\n\n${firstBlock.text}`;
					}
					return wakeResult;
				}

				// No queue, or queue closed (normal shutdown) — return immediately
				return {
					content: [
						{
							type: "text" as const,
							text: `Task marked as ${args.status}. Entering idle state.`,
						},
					],
				};
			},
		),
	];

	return {
		toolDefs,
		hasRunningChildren: () => {
			// Check if any descendants of this task have active queues in globalAgentQueues
			if (!currentTaskId) return false;
			return getDescendantIds(tracker, currentTaskId).some((id) =>
				globalAgentQueues.has(id),
			);
		},
	};
}
