/**
 * MCP tool definitions and handlers for orchestration tools.
 *
 * Extracted for maintainability.
 * Contains createOrchestratorTools() and all tool definitions
 * (create_task, update_task, send_message, yield, done, etc.).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Event } from "./events.ts";
import type { QueueMessage } from "./message-queue.ts";
import {
	createCrossProjectMessage,
	createTaskMessage,
	createTreeChange,
} from "./queue-message-factory.ts";

import {
	closeTaskOp,
	createTaskOp,
	deleteTaskOp,
	reorderTasksOp,
	resetTaskOp,
	updateTaskOp,
} from "./task-operations.ts";
import type { TaskTracker } from "./task-tracker.ts";
import {
	buildTaskPrompt,
	findParentQueue,
	getDescendantIds,
	isDescendantOf,
	slugify,
} from "./task-utils.ts";
import { type ToolDefinition, tool } from "./tool-definition.ts";

import { WorktreeManager } from "./worktree-manager.ts";

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

/**
 * Narrow dependency interface for orchestrator tools.
 * The daemon layer constructs this from DaemonContext when calling createOrchestratorTools.
 * This keeps orchestrator-tools.ts free of daemon/ imports.
 */
export interface OrchestratorToolsDeps {
	/** TaskTracker for this project. */
	tracker: TaskTracker;
	/** Project path (repo root). */
	repoPath: string;
	/** Emit an event (broadcast + optionally persist). */
	emit: (event: Event | Record<string, unknown>) => void;
	/** Broadcast tree update to SSE clients. */
	broadcastTree: () => void;
	/** Clear event store JSONL for a session/task. */
	clearEventStore: (sessionId: string) => void;
	/** Check if a session has JSONL events. */
	hasEventStore: (sessionId: string) => boolean;
	/** Copy session events from source to target, appending a fork_marker. Returns event count. */
	copySessionFrom: (
		sourceId: string,
		targetId: string,
		opts?: { targetTitle?: string; targetDescription?: string },
	) => Promise<{ eventCount: number }>;
	/** Data directory for persisted messages. Undefined if not configured. */
	dataDir?: string;
	/** Get clarify timeout from config. */
	getClarifyTimeoutMs: () => number | undefined;
	/** Get default budget from config. */
	getDefaultBudgetUsd: () => number | undefined;
	/** List all projects with their metadata. */
	listProjects: () => Array<{
		id: string;
		name: string;
		path: string;
		hasActiveAgent: boolean;
	}>;
	/** Get a project by ID. */
	getProject: (
		id: string,
	) => { id: string; name: string; path: string } | undefined;
	/** Get a tracker for another project (cross-project messaging). */
	getTracker: (projectId: string) => TaskTracker | undefined;
}

/**
 * Functions that would cause circular imports if imported directly from agent-lifecycle.ts.
 * Passed as a parameter to avoid the cycle: orchestrator-tools.ts ↔ agent-lifecycle.ts.
 */
export interface LifecycleDeps {
	/** Deliver a message to a task: persist → enqueue (if running) → launch (if not).
	 *  quiet: skip auto-launch when agent is not running (used for upward messages). */
	deliverMessage: (
		nodeId: string,
		message: QueueMessage,
		opts?: { quiet?: boolean },
	) => Promise<void>;
	/**
	 * Inject a message into another project, auto-launching agent if needed.
	 * Only needed at depth 0 for cross-project messaging.
	 */
	injectMessageToProject?: (
		projectId: string,
		message: string,
	) => Promise<{ ok: boolean; error?: string }>;
}

/** Result of createOrchestratorTools — raw tool definitions for provider forwarding. */
export interface OrchestratorToolsResult {
	/** Raw tool definitions for provider forwarding. */
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic is not narrowable here
	toolDefs: ToolDefinition<any>[];
	/** Returns true if this agent has running children (checked via session on tracker). */
	hasRunningChildren?: () => boolean;
	/** Build the ## Pending section for yield tool_result using live tracker data. */
	buildYieldPendingSection?: () => string;
	/**
	 * Bind the live messages[] array from the provider loop into the eval tool handler.
	 * Called by runProviderLoop right after creating the messages array.
	 * Only present when selfBootstrap mode is active.
	 */
	setMessages?: (msgs: unknown[]) => void;
}

/**
 * Create orchestrator tools for an agent.
 *
 * deps provides all external state/callbacks needed by tools.
 * lifecycleDeps provides functions that would cause circular imports if imported directly.
 * selfBootstrap enables the hidden evaluate_script tool for runtime introspection.
 */
export function createOrchestratorTools(
	deps: OrchestratorToolsDeps,
	projectId: string,
	taskId: string | null,
	lifecycleDeps?: LifecycleDeps,
	selfBootstrap?: boolean,
): OrchestratorToolsResult {
	const { tracker, repoPath } = deps;

	const currentTaskId = taskId;

	// Derive depth, queue, and projectPath from session on the task node.
	const getSession = () => (taskId ? tracker.get(taskId)?.session : undefined);
	const getDepth = () => getSession()?.depth ?? 0;
	const getQueue = () => getSession()?.queue;
	const getProjectPath = () =>
		(taskId
			? (tracker.get(taskId)?.worktreePath as string | undefined)
			: undefined) ?? repoPath;

	/** Emit an event through the daemon's unified event system. */
	const emit = (event: Record<string, unknown>) => {
		deps.emit(event);
		deps.broadcastTree();
	};

	const broadcastTree = () => {
		deps.broadcastTree();
	};
	/** Count of outstanding clarify() calls that have not yet received a clarify_response. */
	let pendingClarifications = 0;

	const toolDefs = [
		tool(
			"get_tree",
			"Get the current task tree. Returns all nodes with their status, branch, and hierarchy.",
			{
				format: z.enum(["flat", "tree"]).optional(),
				include_closed: z
					.boolean()
					.optional()
					.describe(
						"Include closed tasks in the result. Default false — closed tasks are hidden to reduce noise.",
					),
				include_details: z
					.boolean()
					.optional()
					.describe(
						"Include full details (description, branch, worktreePath, color, costUsd, etc.) for each node. Default false — returns only id, title, status, children, parentId.",
					),
			},
			async ({ include_closed, include_details }) => {
				let nodes = tracker.allNodes();
				if (!include_closed) {
					nodes = nodes.filter((n) => n.status !== "closed");
				}
				const visibleIds = new Set(nodes.map((n) => n.id));
				const filterChildren = (children: string[]) =>
					children.filter((id) => visibleIds.has(id));
				const result = include_details
					? nodes.map(({ session: _session, ...rest }) => {
							const node: Record<string, unknown> = {
								...rest,
								children: filterChildren(rest.children),
								// Mark calling agent's node so it can discover its position
								...(rest.id === currentTaskId ? { you: true } : {}),
							};
							return node;
						})
					: nodes.map((n) => {
							const node: Record<string, unknown> = {
								id: n.id,
								title: n.title + (n.id === currentTaskId ? " (you)" : ""),
								children: filterChildren(n.children),
								parentId: n.parentId,
							};
							node.status = n.status;
							return node;
						});
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ nodes: result }, null, 2),
						},
					],
				};
			},
		),

		tool(
			"get_task",
			"Get a single task's full details including description. Use when you need to read a specific task's description or other detailed fields.",
			{
				taskId: z
					.string()
					.describe("Task node ID (or unique prefix, min 8 chars)"),
			},
			async ({ taskId }) => {
				const node = tracker.get(taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Task not found: ${taskId}`,
							},
						],
						isError: true,
					};
				}
				const { session: _session, ...rest } = node;
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(rest, null, 2),
						},
					],
				};
			},
		),

		tool(
			"create_task",
			"Create a new task. If parentId is provided, creates a sub task under that parent. " +
				"If omitted, creates a sub task of YOUR current task (or top-level if you are the root orchestrator). " +
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
						"Parent task ID. Omit to create a sub task of your current task.",
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

					// MCP convenience: apply default budget if not explicitly provided
					const defaultBudgetUsd = deps.getDefaultBudgetUsd();
					const budgetUsd = defaultBudgetUsd || undefined;

					const node = await createTaskOp(
						tracker,
						{
							title: args.title,
							description: args.description,
							parentId: effectiveParentId,
							draft: args.draft,
							color: args.color,
							budgetUsd,
						},
						"agent",
						{
							broadcastTree,
							projectPath: getProjectPath(),
						},
					);

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
			"Update a task node. All fields except taskId are optional — provide only the fields you want to change." +
				" For surgical description edits, use old_description + new_description (like edit_file's old_string/new_string)." +
				" Cannot combine description with old_description/new_description.",
			{
				taskId: z.string().describe("Task node ID"),
				status: z
					.enum([
						"draft",
						"pending",
						"in_progress",
						"verify",
						"failed",
						"closed",
					])
					.optional()
					.describe("New status"),
				title: z.string().optional().describe("New title"),
				description: z.string().optional().describe("New description"),
				old_description: z
					.string()
					.optional()
					.describe(
						"Exact substring to find in the current description for surgical edit. Must be unique. Use with new_description.",
					),
				new_description: z
					.string()
					.optional()
					.describe("Replacement string for old_description match."),
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
					// Scope validation for reparent: agent can only reparent tasks under itself or its descendants
					if (args.parentId !== undefined && currentTaskId !== null) {
						if (
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
					}

					// MCP-only: surgical description edit (old_description/new_description)
					// Pre-process into a final `description` before calling shared function.
					let finalDescription = args.description;
					if (
						args.old_description !== undefined ||
						args.new_description !== undefined
					) {
						if (
							args.old_description === undefined ||
							args.new_description === undefined
						) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: old_description and new_description must both be provided",
									},
								],
								isError: true,
							};
						}
						if (args.description !== undefined) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: cannot use description with old_description/new_description — use one or the other",
									},
								],
								isError: true,
							};
						}
						const existingNode = tracker.get(args.taskId);
						if (!existingNode?.description) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: task has no description to edit",
									},
								],
								isError: true,
							};
						}
						const idx = existingNode.description.indexOf(args.old_description);
						if (idx === -1) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: old_description not found in task description",
									},
								],
								isError: true,
							};
						}
						if (
							existingNode.description.indexOf(
								args.old_description,
								idx + 1,
							) !== -1
						) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: old_description is not unique in task description — provide more context to make it unique",
									},
								],
								isError: true,
							};
						}
						finalDescription = existingNode.description.replace(
							args.old_description,
							args.new_description,
						);
					}

					const node = await updateTaskOp(
						tracker,
						args.taskId,
						{
							status: args.status,
							title: args.title,
							description: finalDescription,
							draft: args.draft,
							parentId: args.parentId,
							color: args.color,
						},
						"agent",
						{
							broadcastTree,
							notifyTargetNode: (action, nodeId, title) => {
								// Notify the modified node directly via queue
								if (nodeId !== currentTaskId) {
									const targetNode = tracker.get(nodeId);
									if (targetNode?.session?.queue) {
										try {
											targetNode.session.queue.enqueue(
												createTreeChange(action, nodeId, title),
												{ quiet: true },
											);
										} catch {
											/* queue may be closed */
										}
									}
								}
							},
							projectPath: getProjectPath(),
						},
					);

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
				// Return immediately with _isYield signal. The provider loop intercepts this
				// and enters a loop-level pause instead of sending this result to the API.
				// When messages arrive, the loop calls buildYieldPendingSection() to get
				// live pending data, then constructs the full tool_result.
				// This makes yield state serializable and recoverable across daemon restarts.
				return {
					content: [{ type: "text" as const, text: "" }],
					isError: false,
					_isYield: true,
				};
			},
		),

		tool(
			"send_message",
			"Send a message to another task. You can message the task yours is part of, " +
				"or any of your direct sub tasks. When messaging a sub task that isn't running yet, " +
				"a worktree is auto-created and an agent is launched.",
			{
				taskId: z
					.string()
					.describe(
						"Target task — the task yours is part of, or any direct sub task",
					),
				title: z.string().describe("Short summary of the message"),
				message: z.string().describe("Message content"),
				requestReply: z
					.boolean()
					.optional()
					.describe("If true, signals that a reply is expected."),
			},
			async (args) => {
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

				// Determine direction based on taskId
				const currentNode = currentTaskId
					? tracker.get(currentTaskId)
					: undefined;
				const isUpward =
					currentNode?.parentId != null && args.taskId === currentNode.parentId;
				let isDownward = false;
				if (!isUpward) {
					if (currentTaskId !== null) {
						// Non-root agent: direct children only
						isDownward = node.parentId === currentTaskId;
					} else {
						// Root orchestrator: top-level tasks (children of root node)
						isDownward =
							node.parentId === tracker.rootNodeId || node.parentId === null;
					}
				}

				if (!isUpward && !isDownward) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Can only message the task yours is part of, or your direct sub tasks. "${args.taskId}" is neither.`,
							},
						],
						isError: true,
					};
				}

				// ── Upward message (like old report_to_parent) ──
				if (isUpward) {
					if (!currentNode?.parentId) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No parent agent to report to (you are the top-level orchestrator). Message dropped.",
								},
							],
						};
					}

					const taskTitle = currentNode?.title ?? "unknown";
					const parentId = currentNode.parentId;

					try {
						const queueMessage = createTaskMessage(
							currentTaskId ?? "unknown",
							taskTitle,
							args.message,
							{ title: args.title, requestReply: args.requestReply },
						);

						if (lifecycleDeps?.deliverMessage) {
							// deliverMessage handles JSONL persistence + queue delivery.
							// quiet: true — don't auto-launch a stopped parent.
							await lifecycleDeps.deliverMessage(parentId, queueMessage, {
								quiet: true,
							});
						} else {
							// Fallback for non-daemon contexts (tests without full daemon):
							// direct queue delivery only
							const parentQueue = findParentQueue(
								tracker,
								currentTaskId ?? "",
							)?.queue;
							if (parentQueue) {
								parentQueue.enqueue(queueMessage);
							}
						}

						return {
							content: [
								{
									type: "text" as const,
									text: "Message sent to parent task.",
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

				// ── Downward message (like old send_message_to_child) ──
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
						const projectPath = getProjectPath();
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
						if (!currentNode?.branch) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: Cannot create worktree — current task has no branch assigned.",
									},
								],
								isError: true,
							};
						}
						const slug = slugify(node.title);
						const wtRoot = join(repoPath, ".worktrees");
						const wm = new WorktreeManager(repoPath, wtRoot);
						const wt = await wm.create(node.id, slug, currentNode.branch);
						tracker.assignWorktree(node.id, wt.branch, wt.path);
					}

					// Only include full header on cold start (no prior context).
					// Running agents already have context from their session.
					// Agents with JSONL (e.g. after fork) already have context from events.
					const hasPriorContext =
						node.session != null || deps.hasEventStore(node.id);
					let header: string | undefined;
					if (!hasPriorContext) {
						// Read project memory from the node's worktree (or repo root)
						let memory = "";
						try {
							memory = readFileSync(
								join(node.worktreePath ?? repoPath, ".mxd", "memory.md"),
								"utf-8",
							);
						} catch {
							/* no memory file */
						}
						header = buildTaskPrompt(node, tracker, memory);
					}

					// Deliver message via unified path: persist → enqueue/launch
					// The message is NOT included in the launch prompt — it arrives
					// via queue drain of persisted messages (exactly-once delivery).
					const queueMessage = createTaskMessage(
						currentTaskId ?? "unknown",
						currentNode?.title ?? "unknown",
						args.message,
						{
							requestReply: args.requestReply,
							header: header ?? undefined,
						},
					);

					if (lifecycleDeps?.deliverMessage) {
						await lifecycleDeps.deliverMessage(args.taskId, queueMessage);
					} else {
						// Fallback for non-daemon contexts (tests without full daemon):
						// direct queue delivery only
						const existingQueue = tracker.get(args.taskId)?.session?.queue;
						if (existingQueue) {
							existingQueue.enqueue(queueMessage);
						}
					}

					return {
						content: [
							{
								type: "text" as const,
								text: hasPriorContext
									? `Message sent to task "${node.title}" (${args.taskId})`
									: `Started task "${node.title}" (${args.taskId}) on branch ${node.branch}`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error starting task: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		),

		tool(
			"close_task",
			"Clean up a task's worktree and branch to reclaim disk space. " +
				"Node and session are preserved — status set to 'closed'. " +
				"Call this AFTER you have already merged the task's branch yourself. " +
				"Use for merged tasks or deferred tasks where you want to free resources.",
			{
				taskId: z.string().describe("ID of the task to close"),
			},
			async (args) => {
				try {
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await closeTaskOp(tracker, args.taskId, {
						broadcastTree,
						removeWorktree: (id, slug) => wm.remove(id, slug),
						clearEventStore: deps.clearEventStore,
					});

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ closed: true, ...result }, null, 2),
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
			"Fully remove a task — deletes worktree, session file, and task node from the tree. " +
				"WARNING: Also deletes ALL sub tasks recursively. Verify all sub tasks are completed and merged before deleting. " +
				"Use for abandoned tasks you no longer need.",
			{
				taskId: z.string().describe("ID of the task to delete"),
			},
			async (args) => {
				try {
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await deleteTaskOp(tracker, args.taskId, "agent", {
						broadcastTree,
						removeWorktree: (id, slug) => wm.remove(id, slug),
						clearEventStore: deps.clearEventStore,
					});

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ deleted: true, ...result }, null, 2),
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
			"Reset a task for a fresh start — removes worktree and session file but keeps the node. " +
				"Sets status to pending. Use when you want to retry with a different approach.",
			{
				taskId: z.string().describe("ID of the task to reset"),
			},
			async (args) => {
				try {
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await resetTaskOp(tracker, args.taskId, {
						broadcastTree,
						removeWorktree: (id, slug) => wm.remove(id, slug),
						clearEventStore: deps.clearEventStore,
					});

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ reset: true, ...result }, null, 2),
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
					.describe("The clarification question to ask the user"),
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

					await reorderTasksOp(tracker, args.nodeId, args.children, "agent", {
						broadcastTree,
					});

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
				const depth = getDepth();
				if (depth > 0) {
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
				const projects = deps.listProjects();
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
				const depth = getDepth();
				if (depth > 0) {
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

				const targetProject = deps.getProject(args.projectId);
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
				const senderProject = deps.getProject(projectId);
				const fromProjectId = projectId;
				const fromProjectName = senderProject?.name ?? "unknown";

				// Try direct enqueue if target agent is already running
				const targetTracker = deps.getTracker(args.projectId);
				const targetRootId = targetTracker?.rootNodeId;
				const targetQueue = targetRootId
					? targetTracker?.get(targetRootId)?.session?.queue
					: undefined;
				if (targetQueue) {
					try {
						targetQueue.enqueue(
							createCrossProjectMessage(
								fromProjectId,
								fromProjectName,
								args.message,
							),
						);
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
				if (!lifecycleDeps?.injectMessageToProject) {
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
					const result = await lifecycleDeps.injectMessageToProject(
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
			"fork_task_context",
			"Copy another agent's conversation context into a target task's session. " +
				"Like unix fork(): the parent receives 'Forked context from...' while the child receives " +
				"'This tool was executed by the parent agent...' — the tool_result content tells each agent who they are. " +
				"The target task starts with the source's full conversation history but has its own identity. " +
				"Use this to give a new task the knowledge of a previous agent (files read, patterns discovered, etc.) " +
				"without cold-starting. After forking, use send_message to start the target agent. " +
				"IMPORTANT: fork_task_context must be the ONLY tool call in the turn — it cannot be called alongside other tools.",
			{
				sourceTaskId: z
					.string()
					.describe(
						"ID of the task whose session context to copy. Must have an existing JSONL session.",
					),
				targetTaskId: z
					.string()
					.describe(
						"ID of the task to receive the forked context. Must NOT have an existing session.",
					),
			},
			async (args) => {
				// Validate source exists and has session data
				if (!deps.hasEventStore(args.sourceTaskId)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Source task "${args.sourceTaskId}" has no session data to fork from.`,
							},
						],
						isError: true,
					};
				}

				// Validate target exists
				const targetNode = tracker.get(args.targetTaskId);
				if (!targetNode) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Target task "${args.targetTaskId}" not found.`,
							},
						],
						isError: true,
					};
				}

				// Validate target doesn't already have session data
				if (deps.hasEventStore(args.targetTaskId)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Target task "${args.targetTaskId}" already has session data. Use reset_task first to clear it.`,
							},
						],
						isError: true,
					};
				}

				// Scope validation: agent can only fork into tasks it can manage
				if (
					currentTaskId !== null &&
					args.targetTaskId !== currentTaskId &&
					!isDescendantOf(tracker, args.targetTaskId, currentTaskId)
				) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Error: Target task "${args.targetTaskId}" is not your task or descendant.`,
							},
						],
						isError: true,
					};
				}

				try {
					const result = await deps.copySessionFrom(
						args.sourceTaskId,
						args.targetTaskId,
						{
							targetTitle: targetNode.title,
							targetDescription: targetNode.description,
						},
					);
					return {
						content: [
							{
								type: "text" as const,
								text: `fork_task_context completed. You are the PARENT. Forked ${args.sourceTaskId} → "${targetNode.title}" (${args.targetTaskId}). Copied ${result.eventCount} events. Use send_message to start the child agent.`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text" as const,
								text: `Error forking context: ${message}`,
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
			async (_args) => {
				// Phase 1 of two-phase done(): just close the queue and return.
				// Status update, parent notification, and done_notified happen in Phase 2
				// (runAgentForNode, after the provider loop exits).
				// done() tool_call stays as an orphan in JSONL (no tool_result emitted) —
				// the provider loop detects done and skips tool_result emission, like yield().
				const queue = getQueue();
				if (queue) {
					queue.close();
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Done acknowledged (${_args.status}).`,
						},
					],
				};
			},
		),
	];

	// ── Hidden evaluate_script tool (selfBootstrap only) ──
	// Mutable ref bound later by runProviderLoop via setMessages().
	let messagesRef: unknown[] = [];
	let setMessages: ((msgs: unknown[]) => void) | undefined;

	if (selfBootstrap) {
		setMessages = (msgs: unknown[]) => {
			messagesRef = msgs;
		};

		const evalTool = tool(
			"evaluate_script",
			"Execute arbitrary JavaScript/TypeScript code for runtime introspection. " +
				"Only available in self-bootstrap mode.",
			{
				script: z.string().describe("JavaScript/TypeScript code to evaluate"),
			},
			async (args) => {
				try {
					// Build a context object with useful references for introspection.
					// The eval'd code accesses these via the `ctx` variable.
					const evalContext = {
						messages: messagesRef,
						tracker,
						queue: getQueue(),
						deps,
						projectId,
						taskId: currentTaskId,
					};

					// Use AsyncFunction to support await in eval'd code.
					// The function receives `ctx` as its argument.
					const AsyncFunction = Object.getPrototypeOf(
						async () => {},
					).constructor;
					const fn = new AsyncFunction("ctx", args.script);

					// Capture console output
					const logs: string[] = [];
					const origLog = console.log;
					const origError = console.error;
					const origWarn = console.warn;
					console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
					console.error = (...a: unknown[]) =>
						logs.push(`[error] ${a.map(String).join(" ")}`);
					console.warn = (...a: unknown[]) =>
						logs.push(`[warn] ${a.map(String).join(" ")}`);

					let result: unknown;
					try {
						result = await fn(evalContext);
					} finally {
						console.log = origLog;
						console.error = origError;
						console.warn = origWarn;
					}

					const parts: string[] = [];
					if (logs.length > 0) {
						parts.push(`## Console Output\n${logs.join("\n")}`);
					}
					if (result !== undefined) {
						const resultStr =
							typeof result === "string"
								? result
								: JSON.stringify(result, null, 2);
						parts.push(`## Return Value\n${resultStr}`);
					}

					return {
						content: [
							{
								type: "text" as const,
								text: parts.length > 0 ? parts.join("\n\n") : "(no output)",
							},
						],
					};
				} catch (e) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Eval error: ${e instanceof Error ? e.message : String(e)}${e instanceof Error && e.stack ? `\n${e.stack}` : ""}`,
							},
						],
						isError: true,
					};
				}
			},
		);
		// Mark as hidden — prepareTools registers it in mcpHandlers but
		// does NOT include it in the tool definitions sent to the API.
		evalTool.hidden = true;
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies across tools in the array
		toolDefs.push(evalTool as ToolDefinition<any>);
	}

	return {
		toolDefs,
		setMessages,
		hasRunningChildren: () => {
			// Check if any descendants of this task have active sessions
			if (!currentTaskId) return false;
			return getDescendantIds(tracker, currentTaskId).some(
				(id) => tracker.get(id)?.session != null,
			);
		},
		buildYieldPendingSection: () => {
			// Build ## Pending section using live tracker data at resume time
			const myDescendants = currentTaskId
				? getDescendantIds(tracker, currentTaskId)
				: [];
			const runningChildren = myDescendants.filter(
				(id) => tracker.get(id)?.session != null,
			);
			const runningChildrenData = runningChildren.map((id) => ({
				id,
				title: tracker.get(id)?.title ?? id,
			}));
			const runningChildrenText =
				runningChildrenData.length > 0
					? runningChildrenData.map((c) => `"${c.title}" (${c.id})`).join(", ")
					: "none";
			const clarifyText =
				pendingClarifications > 0 ? String(pendingClarifications) : "none";
			return [
				"## Pending",
				`- Running sub tasks: ${runningChildrenText}`,
				`- Pending clarifications: ${clarifyText}`,
			].join("\n");
		},
	};
}
