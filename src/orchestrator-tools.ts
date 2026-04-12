/**
 * MCP tool definitions and handlers for orchestration tools.
 *
 * All tools are ToolDef objects:
 * - Handlers receive (args, auth, toolCallId)
 * - Resource IDs come through args (via ParamDecl bind/explicit)
 * - Auth checked via checkPermission (opaque, only auth module can inspect)
 * - Dependencies accessed through global functions in resource-registry.ts
 *
 * createOrchestratorTools() converts ToolDefs to ToolDefinitions
 * for backward compatibility with the existing provider loop.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { stripEventForUI } from "./daemon/helpers.ts";
import {
	createCrossProjectMessage,
	createTaskMessage,
	createTreeChange,
} from "./queue-message-factory.ts";
import * as R from "./resource-registry.ts";
import {
	closeTaskOp,
	createTaskOp,
	deleteTaskOp,
	reorderTasksOp,
	resetTaskOp,
	updateTaskOp,
} from "./task-operations.ts";
import { buildTaskPrompt, getDescendantIds, slugify } from "./task-utils.ts";
import type { Auth } from "./tool-auth.ts";
import { checkPermission } from "./tool-auth.ts";
import { type ToolDef, toToolDefinition } from "./tool-def.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import { isFolder, isTask, stripSession, type TaskStatus } from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

// ── Helper ──

async function isGitClean(projectPath: string): Promise<{
	clean: boolean;
	files: string;
}> {
	const proc = Bun.spawn(["git", "status", "--porcelain"], {
		cwd: projectPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	const output = (await new Response(proc.stdout).text()).trim();
	return { clean: output === "", files: output };
}

/** Get project path for a task (worktree path or repo root). */
function getProjectPath(projectId: string, taskId: string | null): string {
	const tracker = R.getTracker(projectId);
	if (taskId && tracker) {
		const wp = tracker.getTask(taskId)?.worktreePath;
		if (wp) return wp;
	}
	return R.getProject(projectId)?.path ?? "";
}

// ── All tool definitions ──

export function buildAllToolDefs(): ToolDef[] {
	return [
		// ── get_tree ──
		{
			name: "get_tree",
			availability: "both",
			description:
				"Get the current task tree. Returns all nodes with their status, branch, and hierarchy.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				format: {
					schema: z.enum(["flat", "tree"]),
					decl: { kind: "optional" },
				},
				include_closed: {
					schema: z.boolean(),
					decl: { kind: "optional" },
					description:
						"Include closed tasks in the result. Default false — closed tasks are hidden to reduce noise.",
				},
				include_details: {
					schema: z.boolean(),
					decl: { kind: "optional" },
					description:
						"Include full details (description, branch, worktreePath, color, costUsd, etc.) for each node. Default false — returns only id, title, status, children, parentId.",
				},
			},
			handler: async (args, auth) => {
				const tracker = R.getTracker(args.projectId as string);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};
				// "(you)" marker: agents get their node marked, humans skip.
				const isMe = checkPermission(auth, "human", {})
					? (_nodeId: string) => false
					: (nodeId: string) =>
							checkPermission(auth, "exact", { taskId: nodeId });
				let nodes = tracker.allNodes();
				if (!args.include_closed) {
					nodes = nodes.filter((n) => isFolder(n) || n.status !== "closed");
				}
				const visibleIds = new Set(nodes.map((n) => n.id));
				const filterChildren = (children: string[]) =>
					children.filter((id) => visibleIds.has(id));
				const result = args.include_details
					? nodes.map((n) => {
							if (isFolder(n))
								return { ...n, children: filterChildren(n.children) };
							const rest = stripSession(n);
							return {
								...rest,
								children: filterChildren(rest.children),
								...(isMe(rest.id) ? { you: true } : {}),
							};
						})
					: nodes.map((n) => {
							const node: Record<string, unknown> = {
								id: n.id,
								title: n.title + (isMe(n.id) ? " (you)" : ""),
								children: filterChildren(n.children),
								parentId: n.parentId,
							};
							if (isTask(n)) node.status = n.status;
							if (isFolder(n)) node.type = "folder";
							return node;
						});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ nodes: result }, null, 2),
						},
					],
				};
			},
		},

		// ── get_task ──
		{
			name: "get_task",
			availability: "both",
			description:
				"Get a single task's full details including description. Use when you need to read a specific task's description or other detailed fields.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z
						.string()
						.describe("Task node ID (or unique prefix, min 8 chars)"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				const tracker = R.getTracker(args.projectId as string);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};
				const node = tracker.getTask(args.taskId as string);
				if (!node)
					return {
						content: [{ type: "text", text: `Task not found: ${args.taskId}` }],
						isError: true,
					};
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(stripSession(node), null, 2),
						},
					],
				};
			},
		},

		// ── create_task ──
		{
			name: "create_task",
			availability: "internal",
			description:
				"Create a new task. " +
				"IMPORTANT: Sibling tasks will run in PARALLEL on separate branches. " +
				"Each sibling must work on DIFFERENT files/modules to avoid merge conflicts. " +
				"NOTE: You can create tasks anywhere in the tree, not just under your own subtree. " +
				"Creating a task is recording an intention — it's always allowed.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				parentId: {
					schema: z.string(),
					decl: { kind: "explicit" },
					description: "Parent task ID.",
				},
				title: {
					schema: z.string().describe("Short title for the task"),
					decl: { kind: "explicit" },
				},
				description: {
					schema: z
						.string()
						.describe(
							"Detailed description of what the task should accomplish",
						),
					decl: { kind: "explicit" },
				},
				draft: {
					schema: z.boolean(),
					decl: { kind: "optional" },
					description:
						"If true, creates the task as a draft. Draft tasks can be edited but not executed.",
				},
				color: {
					schema: z.string(),
					decl: { kind: "optional" },
					description:
						"Optional color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex like '#ff5733'). " +
						"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
				},
			},
			handler: async (args) => {
				try {
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const defaultBudgetUsd = R.getDefaultBudgetUsd();
					const node = await createTaskOp(
						tracker,
						{
							title: args.title as string,
							description: args.description as string,
							parentId: args.parentId as string,
							draft: args.draft as boolean | undefined,
							color: args.color as string | undefined,
							budgetUsd: defaultBudgetUsd || undefined,
						},
						"agent",
						{
							broadcastTree: () => R.broadcastTree(args.projectId as string),
							projectPath: getProjectPath(
								args.projectId as string,
								args.parentId as string | null,
							),
						},
					);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(stripSession(node), null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		// ── update_task ──
		{
			name: "update_task",
			availability: "internal",
			description:
				"Update a task node. All fields except taskId are optional — " +
				"provide only the fields you want to change.\n\n" +
				"**Editing the description field**: treat it like a file. " +
				"Use `description` for a full rewrite (replaces the ENTIRE field). " +
				"Use `old_description` + `new_description` for surgical edits — " +
				"SAME semantics as `edit_file`'s `old_string`/`new_string`: " +
				"the exact substring `old_description` is replaced by `new_description`, " +
				"and everything else stays byte-identical. " +
				"If `old_description` is not unique, provide more surrounding context to disambiguate. " +
				"Cannot combine `description` with `old_description`/`new_description`.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("Task node ID"),
					decl: { kind: "explicit" },
				},
				status: {
					schema: z.enum([
						"draft",
						"pending",
						"in_progress",
						"verify",
						"failed",
						"closed",
					]),
					decl: { kind: "optional" },
					description: "New status",
				},
				title: {
					schema: z.string(),
					decl: { kind: "optional" },
					description: "New title",
				},
				description: {
					schema: z.string(),
					decl: { kind: "optional" },
					description:
						"Replaces the ENTIRE description field (full rewrite). " +
						"Use this for major rewrites. For local edits, prefer " +
						"old_description/new_description to avoid accidentally dropping content.",
				},
				old_description: {
					schema: z.string(),
					decl: { kind: "optional" },
					description:
						"Exact substring to find in the current description. Must be unique. " +
						"ONLY this substring is replaced — the rest of the description stays " +
						"byte-identical. Same semantics as edit_file's old_string. " +
						"If you intend to replace the whole description, use the `description` parameter instead.",
				},
				new_description: {
					schema: z.string(),
					decl: { kind: "optional" },
					description:
						"Replacement string for the old_description match. Same semantics as " +
						"edit_file's new_string — only what matched old_description is replaced, " +
						"nothing else in the description changes.",
				},
				draft: {
					schema: z.boolean(),
					decl: { kind: "optional" },
					description:
						"Set draft flag. true = status becomes 'draft', false = status becomes 'pending'.",
				},
				parentId: {
					schema: z.string(),
					decl: { kind: "optional" },
					description:
						"New parent task ID. Moves the task under this parent (reparent).",
				},
				color: {
					schema: z.string(),
					decl: { kind: "optional" },
					description:
						"Color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex). " +
						"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
				},
			},
			handler: async (args, auth) => {
				try {
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};

					// Scope validation for reparent via auth
					if (args.parentId !== undefined) {
						if (
							!checkPermission(auth, "subtree", {
								taskId: args.taskId as string,
							})
						) {
							return {
								content: [
									{
										type: "text",
										text: `Cannot reparent ${args.taskId}: not your task or descendant`,
									},
								],
								isError: true,
							};
						}
						if (
							!checkPermission(auth, "subtree", {
								taskId: args.parentId as string,
							})
						) {
							return {
								content: [
									{
										type: "text",
										text: `Cannot reparent under ${args.parentId}: not your task or descendant`,
									},
								],
								isError: true,
							};
						}
					}

					// Surgical description edit
					let finalDescription = args.description as string | undefined;
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
										type: "text",
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
										type: "text",
										text: "Error: cannot use description with old_description/new_description — use one or the other",
									},
								],
								isError: true,
							};
						}
						const existingNode = tracker.getTask(args.taskId as string);
						if (!existingNode?.description) {
							return {
								content: [
									{
										type: "text",
										text: "Error: task has no description to edit",
									},
								],
								isError: true,
							};
						}
						const idx = existingNode.description.indexOf(
							args.old_description as string,
						);
						if (idx === -1) {
							return {
								content: [
									{
										type: "text",
										text: "Error: old_description not found in task description",
									},
								],
								isError: true,
							};
						}
						if (
							existingNode.description.indexOf(
								args.old_description as string,
								idx + 1,
							) !== -1
						) {
							return {
								content: [
									{
										type: "text",
										text: "Error: old_description is not unique in task description — provide more context to make it unique",
									},
								],
								isError: true,
							};
						}
						finalDescription = existingNode.description.replace(
							args.old_description as string,
							args.new_description as string,
						);
					}

					const node = await updateTaskOp(
						tracker,
						args.taskId as string,
						{
							status: args.status as TaskStatus | undefined,
							title: args.title as string | undefined,
							description: finalDescription,
							draft: args.draft as boolean | undefined,
							parentId: args.parentId as string | undefined,
							color: args.color as string | undefined,
						},
						"agent",
						{
							broadcastTree: () => R.broadcastTree(args.projectId as string),
							notifyTargetNode: (action, nodeId, title) => {
								const targetNode = tracker.getTask(nodeId);
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
							},
							projectPath: getProjectPath(args.projectId as string, null),
						},
					);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(stripSession(node), null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		// ── yield ──
		{
			name: "yield",
			availability: "internal",
			description:
				"Suspend execution and wait for messages (child completions, user messages, etc.). " +
				"Call this when you have spawned tasks and are waiting for results. " +
				"Returns all accumulated messages. Zero token burn while waiting.",
			params: {},
			handler: async () => {
				return {
					content: [{ type: "text", text: "" }],
					isError: false,
					_isYield: true,
				};
			},
		},

		// ── send_message ──
		{
			name: "send_message",
			availability: "internal",
			description:
				"Send a message to another task. You can message any ancestor in your parent chain (not just direct parent), " +
				"or any of your direct sub tasks. When messaging a sub task that isn't running yet, " +
				"a worktree is auto-created and an agent is launched.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				senderTaskId: {
					schema: z.string(),
					decl: { kind: "bind", from: "taskId" },
				},
				taskId: {
					schema: z
						.string()
						.describe(
							"Target task — any ancestor in your parent chain, or any direct sub task",
						),
					decl: { kind: "explicit" },
				},
				title: {
					schema: z.string().describe("Short summary of the message"),
					decl: { kind: "explicit" },
				},
				message: {
					schema: z.string().describe("Message content"),
					decl: { kind: "explicit" },
				},
				requestReply: {
					schema: z.boolean(),
					decl: { kind: "optional" },
					description: "If true, signals that a reply is expected.",
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const senderTaskId = args.senderTaskId as string | null;
				const targetTaskId = args.taskId as string;
				const tracker = R.getTracker(projectId);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};

				const node = tracker.getTask(targetTaskId);
				if (!node)
					return {
						content: [
							{
								type: "text",
								text: `Error: Task "${targetTaskId}" not found.`,
							},
						],
						isError: true,
					};

				const currentNode = senderTaskId
					? tracker.getTask(senderTaskId)
					: undefined;

				// Direction check: upward or downward
				let isUpward = false;
				if (senderTaskId) {
					let ancestor = tracker.getTaskAbove(senderTaskId);
					while (ancestor) {
						if (ancestor.id === targetTaskId) {
							isUpward = true;
							break;
						}
						ancestor = tracker.getTaskAbove(ancestor.id);
					}
				}
				let isDownward = false;
				if (!isUpward) {
					if (senderTaskId !== null) {
						const targetTaskAbove = tracker.getTaskAbove(targetTaskId);
						isDownward = targetTaskAbove?.id === senderTaskId;
					} else {
						const targetTaskAbove = tracker.getTaskAbove(targetTaskId);
						isDownward =
							targetTaskAbove?.id === tracker.rootNodeId || !targetTaskAbove;
					}
				}

				if (!isUpward && !isDownward)
					return {
						content: [
							{
								type: "text",
								text: `Error: Can only message ancestors in your parent chain, or your direct sub tasks. "${targetTaskId}" is neither.`,
							},
						],
						isError: true,
					};

				// ── Upward ──
				if (isUpward) {
					try {
						const queueMessage = createTaskMessage(
							senderTaskId ?? "unknown",
							currentNode?.title ?? "unknown",
							args.message as string,
							{
								title: args.title as string,
								requestReply: args.requestReply as boolean | undefined,
							},
						);
						await R.deliverMessage(projectId, targetTaskId, queueMessage, {
							quiet: true,
						});
						return {
							content: [
								{
									type: "text",
									text: `Message sent to ancestor task "${node.title}".`,
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [
								{
									type: "text",
									text: `Error sending message: ${message}`,
								},
							],
							isError: true,
						};
					}
				}

				// ── Downward ──
				if (node.status === "draft")
					return {
						content: [
							{
								type: "text",
								text: `Error: Task "${node.title}" (${targetTaskId}) is a draft and cannot be started. Remove draft status first.`,
							},
						],
						isError: true,
					};

				try {
					// Create worktree if needed
					if (!node.worktreePath) {
						const projPath = getProjectPath(projectId, senderTaskId);
						const gitCheck = await isGitClean(projPath);
						if (!gitCheck.clean) {
							const lines = gitCheck.files.split("\n").filter((l) => l.trim());
							return {
								content: [
									{
										type: "text",
										text: `Error: Working tree has ${lines.length} uncommitted change(s):\n${gitCheck.files}\n\nCommit or stash changes before spawning tasks.`,
									},
								],
								isError: true,
							};
						}
						if (!currentNode?.branch)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot create worktree — current task has no branch assigned.",
									},
								],
								isError: true,
							};
						const repoPath = R.getProject(projectId)?.path ?? "";
						const slug = slugify(node.title);
						const wtRoot = join(repoPath, ".worktrees");
						const wm = new WorktreeManager(repoPath, wtRoot);
						const wt = await wm.create(node.id, slug, currentNode.branch);
						tracker.assignWorktree(node.id, wt.branch, wt.path);
					}

					const hasPriorContext =
						node.session != null || R.hasEventStore(projectId, node.id);
					let header: string | undefined;
					if (!hasPriorContext) {
						const repoPath = R.getProject(projectId)?.path ?? "";
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

					const queueMessage = createTaskMessage(
						senderTaskId ?? "unknown",
						currentNode?.title ?? "unknown",
						args.message as string,
						{
							requestReply: args.requestReply as boolean | undefined,
							header: header ?? undefined,
						},
					);

					await R.deliverMessage(projectId, targetTaskId, queueMessage);

					return {
						content: [
							{
								type: "text",
								text: hasPriorContext
									? `Message sent to task "${node.title}" (${targetTaskId})`
									: `Started task "${node.title}" (${targetTaskId}) on branch ${node.branch}`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text",
								text: `Error starting task: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		},

		// ── close_task ──
		{
			name: "close_task",
			availability: "internal",
			description:
				"Clean up a task's worktree and branch to reclaim disk space. " +
				"Node and session are preserved — status set to 'closed'. " +
				"Call this AFTER you have already merged the task's branch yourself. " +
				"Use for merged tasks or deferred tasks where you want to free resources.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("ID of the task to close"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				try {
					const projectId = args.projectId as string;
					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const repoPath = R.getProject(projectId)?.path ?? "";
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await closeTaskOp(tracker, args.taskId as string, {
						broadcastTree: () => R.broadcastTree(projectId),
						removeWorktree: (id, slug) => wm.remove(id, slug),
						clearEventStore: (sid) => R.clearEventStore(projectId, sid),
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ closed: true, ...result }, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		// ── delete_task ──
		{
			name: "delete_task",
			availability: "internal",
			description:
				"Fully remove a task — deletes worktree, session file, and task node from the tree. " +
				"WARNING: Also deletes ALL sub tasks recursively. Verify all sub tasks are completed and merged before deleting. " +
				"Use for abandoned tasks you no longer need.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("ID of the task to delete"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				try {
					const projectId = args.projectId as string;
					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const repoPath = R.getProject(projectId)?.path ?? "";
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await deleteTaskOp(
						tracker,
						args.taskId as string,
						"agent",
						{
							broadcastTree: () => R.broadcastTree(projectId),
							removeWorktree: (id, slug) => wm.remove(id, slug),
							clearEventStore: (sid) => R.clearEventStore(projectId, sid),
						},
					);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ deleted: true, ...result }, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		// ── reset_task ──
		{
			name: "reset_task",
			availability: "internal",
			description:
				"Reset a task for a fresh start — removes worktree and session file but keeps the node. " +
				"Sets status to pending. Use when you want to retry with a different approach.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("ID of the task to reset"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				try {
					const projectId = args.projectId as string;
					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const repoPath = R.getProject(projectId)?.path ?? "";
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await resetTaskOp(tracker, args.taskId as string, {
						broadcastTree: () => R.broadcastTree(projectId),
						removeWorktree: (id, slug) => wm.remove(id, slug),
						clearEventStore: (sid) => R.clearEventStore(projectId, sid),
						stopTask: async (nodeId) => {
							await R.stopTask(projectId, nodeId);
						},
						awaitLoopExit: (nodeId) => R.awaitLoopExit(nodeId),
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ reset: true, ...result }, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		// ── clarify ──
		{
			name: "clarify",
			availability: "internal",
			description:
				"Ask a clarification question and send it to the user. " +
				"Returns immediately — you can continue doing other work that doesn't need the answer, " +
				"then call yield() when ready to wait for the clarify_response. " +
				"Only use this for genuine ambiguities that could lead to wasted work.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string(),
					decl: { kind: "bind", from: "taskId" },
				},
				question: {
					schema: z
						.string()
						.describe("The clarification question to ask the user"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				const taskId = (args.taskId as string) ?? "orchestrator";
				R.emit(args.projectId as string, {
					type: "clarification_requested",
					taskId,
					question: args.question as string,
					...((args.question as string).includes("\n")
						? {
								title: (args.question as string).split("\n")[0],
								body: (args.question as string)
									.split("\n")
									.slice(1)
									.join("\n")
									.trim(),
							}
						: { title: args.question }),
				});
				R.broadcastTree(args.projectId as string);
				return {
					content: [
						{
							type: "text",
							text: "Question sent. You can continue working on other things that don't need the answer, then call yield() when ready to receive the clarify_response.",
						},
					],
				};
			},
		},

		// ── reorder_tasks ──
		{
			name: "reorder_tasks",
			availability: "internal",
			description:
				"Reorder children of a task node. The children array must contain exactly the same task IDs as the current children, just in a different order.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				nodeId: {
					schema: z
						.string()
						.describe("Parent task ID whose children to reorder"),
					decl: { kind: "explicit" },
				},
				children: {
					schema: z
						.array(z.string())
						.describe("Ordered list of child task IDs"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					// Scope validation via auth
					if (
						!checkPermission(auth, "subtree", {
							taskId: args.nodeId as string,
						})
					) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot reorder children of ${args.nodeId}: not your task or descendant`,
								},
							],
							isError: true,
						};
					}
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					await reorderTasksOp(
						tracker,
						args.nodeId as string,
						args.children as string[],
						"agent",
						{
							broadcastTree: () => R.broadcastTree(args.projectId as string),
						},
					);
					return {
						content: [
							{
								type: "text",
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
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		// ── Folder tools ──
		{
			name: "create_folder",
			availability: "internal",
			description:
				"Create a folder for visual grouping. Folders have no status, no lifecycle — pure organization. " +
				"Tasks inside folders are logically owned by the nearest task ancestor above the folder.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				parentId: {
					schema: z.string(),
					decl: { kind: "explicit" },
					description: "Parent node ID.",
				},
				title: {
					schema: z.string().describe("Folder title"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				try {
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const folder = tracker.addFolder(
						args.title as string,
						args.parentId as string,
					);
					await tracker.save();
					R.broadcastTree(args.projectId as string);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(folder, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		{
			name: "delete_folder",
			availability: "internal",
			description:
				"Delete an empty folder. Fails if the folder has children — move or delete them first.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				folderId: {
					schema: z.string().describe("ID of the folder to delete"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				try {
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const node = tracker.get(args.folderId as string);
					if (!node)
						return {
							content: [{ type: "text", text: "Folder not found" }],
							isError: true,
						};
					if (!isFolder(node))
						return {
							content: [
								{
									type: "text",
									text: "Not a folder — use delete_task instead",
								},
							],
							isError: true,
						};
					if (node.children.length > 0)
						return {
							content: [
								{
									type: "text",
									text: "Cannot delete folder with children. Move or delete them first.",
								},
							],
							isError: true,
						};
					tracker.remove(args.folderId as string);
					await tracker.save();
					R.broadcastTree(args.projectId as string);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									deleted: true,
									folderId: args.folderId,
									title: node.title,
								}),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		{
			name: "rename_folder",
			availability: "internal",
			description: "Rename a folder.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				folderId: {
					schema: z.string().describe("ID of the folder to rename"),
					decl: { kind: "explicit" },
				},
				title: {
					schema: z.string().describe("New title for the folder"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				try {
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const node = tracker.get(args.folderId as string);
					if (!node)
						return {
							content: [{ type: "text", text: "Folder not found" }],
							isError: true,
						};
					if (!isFolder(node))
						return {
							content: [
								{
									type: "text",
									text: "Not a folder — use update_task instead",
								},
							],
							isError: true,
						};
					tracker.updateTitle(args.folderId as string, args.title as string);
					await tracker.save();
					R.broadcastTree(args.projectId as string);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									renamed: true,
									folderId: args.folderId,
									title: args.title,
								}),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		},

		// ── list_projects ──
		{
			name: "list_projects",
			availability: "both",
			description:
				"List all registered projects with their IDs, names, and paths. " +
				"Use this to discover other projects before sending cross-project messages.",
			params: {},
			handler: async (_args, auth) => {
				if (!checkPermission(auth, "root", {})) {
					return {
						content: [
							{
								type: "text",
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}
				const projects = R.listProjects();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(projects, null, 2),
						},
					],
				};
			},
		},

		// ── get_logs ──
		{
			name: "get_logs",
			availability: "both",
			description:
				"Returns session events for a task, with cursor-based pagination. " +
				"Events are returned after the last compact/fork marker. " +
				"Use begin/end cursors to read a range (e.g., from yield_external's cursor).",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("Task node ID to fetch logs for"),
					decl: { kind: "explicit" },
				},
				begin: {
					schema: z.number(),
					decl: { kind: "optional" },
					description:
						"Start cursor (inclusive). Events from this position onward.",
				},
				end: {
					schema: z.number(),
					decl: { kind: "optional" },
					description: "End cursor (exclusive). Events up to this position.",
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const tracker = R.getTracker(projectId);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};
				const node = tracker.getTask(taskId);
				if (!node)
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						isError: true,
					};
				const eventStore = R.getEventStore(projectId);
				await eventStore.flushSession(taskId);
				const { events: allEvents, hasOlderEvents } =
					eventStore.readFromLastCompactMarker(taskId);
				const begin = args.begin as number | undefined;
				const end = args.end as number | undefined;
				// Apply cursor range — precise slice, no limit needed
				const sliced = allEvents.slice(begin ?? 0, end);
				const stripped = sliced.map((e) =>
					stripEventForUI(e as unknown as Record<string, unknown>),
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									taskId,
									events: stripped,
									cursor: allEvents.length,
									hasOlderEvents,
								},
								null,
								2,
							),
						},
					],
				};
			},
		},

		// ── send_message_to_project ──
		{
			name: "send_message_to_project",
			availability: "internal",
			description:
				"Send a message to the orchestrator of another project. " +
				"The message appears in the target project's orchestrator queue as a cross_project message. " +
				"If the target project has no active agent, one is auto-launched with the message as the initial prompt.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
					description: "Sender's project ID (auto-bound).",
				},
				targetProjectId: {
					schema: z.string().describe("ID of the target project"),
					decl: { kind: "explicit" },
				},
				message: {
					schema: z.string().describe("Message content to send"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				if (!checkPermission(auth, "root", {})) {
					return {
						content: [
							{
								type: "text",
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}
				const senderProjectId = args.projectId as string;
				const targetProjectId = args.targetProjectId as string;

				const targetProject = R.getProject(targetProjectId);
				if (!targetProject)
					return {
						content: [
							{
								type: "text",
								text: `Error: Project "${targetProjectId}" not found.`,
							},
						],
						isError: true,
					};

				const senderProject = R.getProject(senderProjectId);
				const fromProjectName = senderProject?.name ?? "unknown";

				// Try direct enqueue if target agent is running
				const targetTracker = R.getTracker(targetProjectId);
				const targetRootId = targetTracker?.rootNodeId;
				const targetQueue = targetRootId
					? targetTracker?.getTask(targetRootId)?.session?.queue
					: undefined;
				if (targetQueue) {
					try {
						targetQueue.enqueue(
							createCrossProjectMessage(
								senderProjectId,
								fromProjectName,
								args.message as string,
							),
						);
						return {
							content: [
								{
									type: "text",
									text: `Message sent to project "${targetProject.name}" (${targetProjectId}).`,
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [
								{
									type: "text",
									text: `Error sending message: ${message}`,
								},
							],
							isError: true,
						};
					}
				}

				// Auto-launch via inject
				try {
					const prefixedMessage = `[Cross-project message from "${fromProjectName}" (${senderProjectId})]\n\n${args.message}`;
					const result = await R.injectMessageToProject(
						targetProjectId,
						prefixedMessage,
					);
					if (!result.ok) {
						return {
							content: [
								{
									type: "text",
									text: `Error: ${result.error ?? "Failed to launch agent for target project."}`,
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Message sent to project "${targetProject.name}" (${targetProjectId}). Agent was not running and has been auto-launched.`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text",
								text: `Error sending message: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		},

		// ── fork_task_context ──
		{
			name: "fork_task_context",
			availability: "internal",
			description:
				"Copy a task's conversation context into a target task's session. " +
				"When sourceTaskId == your own taskId, the system picks your next assignment afterward — follow the tool result. " +
				"When sourceTaskId is another task, you remain unchanged — you're orchestrating a context transfer. " +
				"The target task starts with the source's full conversation history so the new agent doesn't cold-start. After forking, use send_message to start the target agent. " +
				"IMPORTANT: fork_task_context must be the ONLY tool call in the turn — it cannot be called alongside other tools.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				sourceTaskId: {
					schema: z
						.string()
						.describe(
							"ID of the task whose session context to copy. Must have an existing JSONL session.",
						),
					decl: { kind: "explicit" },
				},
				targetTaskId: {
					schema: z
						.string()
						.describe(
							"ID of the task to receive the forked context. Must NOT have an existing session.",
						),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				const projectId = args.projectId as string;
				const sourceId = args.sourceTaskId as string;
				const targetId = args.targetTaskId as string;

				if (!R.hasEventStore(projectId, sourceId))
					return {
						content: [
							{
								type: "text",
								text: `Error: Source task "${sourceId}" has no session data to fork from.`,
							},
						],
						isError: true,
					};

				const tracker = R.getTracker(projectId);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};

				const targetNode = tracker.getTask(targetId);
				if (!targetNode)
					return {
						content: [
							{
								type: "text",
								text: `Error: Target task "${targetId}" not found.`,
							},
						],
						isError: true,
					};

				if (R.hasEventStore(projectId, targetId))
					return {
						content: [
							{
								type: "text",
								text: `Error: Target task "${targetId}" already has session data. Use reset_task first to clear it.`,
							},
						],
						isError: true,
					};

				// Scope validation via auth
				if (!checkPermission(auth, "subtree", { taskId: targetId })) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Target task "${targetId}" is not your task or descendant.`,
							},
						],
						isError: true,
					};
				}

				try {
					const result = await R.copySessionFrom(
						projectId,
						sourceId,
						targetId,
						{
							targetTitle: targetNode.title,
							targetDescription: targetNode.description,
						},
					);
					return {
						content: [
							{
								type: "text",
								text: `fork_task_context completed. You are the PARENT. Forked ${sourceId} → "${targetNode.title}" (${targetId}). Copied ${result.eventCount} events. Use send_message to start the child agent.`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text",
								text: `Error forking context: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		},

		// ── done ──
		{
			name: "done",
			availability: "internal",
			description:
				"Signal that you have finished working on your task. " +
				"Call this when you are done — either passed (task completed successfully) or failed (you cannot continue). " +
				"This is the proper way to exit. Do NOT just stop responding — always call done().",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string(),
					decl: { kind: "bind", from: "taskId" },
				},
				status: {
					schema: z
						.enum(["passed", "failed"])
						.describe("Whether the task passed or failed"),
					decl: { kind: "explicit" },
				},
				summary: {
					schema: z
						.string()
						.describe(
							"Brief summary of what was accomplished (if passed) or what went wrong (if failed)",
						),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const tracker = R.getTracker(projectId);

				// Guard: reject done() if any descendants have active sessions
				if (taskId && tracker) {
					const runningDescendants = getDescendantIds(tracker, taskId)
						.filter((id) => tracker.getTask(id)?.session != null)
						.map((id) => {
							const n = tracker.get(id);
							return `${n?.title ?? id} (${id})`;
						});
					if (runningDescendants.length > 0) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot call done() while child tasks are still running:\n${runningDescendants.map((r) => `  - ${r}`).join("\n")}\nWait for them to complete or stop them first.`,
								},
							],
							isError: true,
						};
					}
				}

				// Guard: reject done() if worktree has uncommitted changes
				const projPath = getProjectPath(projectId, taskId);
				const gitCheck = await isGitClean(projPath);
				if (!gitCheck.clean) {
					return {
						content: [
							{
								type: "text",
								text:
									`Cannot call done() — your worktree has uncommitted changes:\n${gitCheck.files}\n\n` +
									`Resolve this yourself — protect your work, do the right thing. ` +
									`If you're waiting for direction on what to do with these changes, call yield() instead of done().`,
							},
						],
						isError: true,
					};
				}

				// Phase 1 of two-phase done(): close queue and return.
				const session = R.getSession(projectId, taskId);
				const queue = session?.queue;
				if (queue) {
					queue.close();
				}

				return {
					content: [
						{
							type: "text",
							text: `Done acknowledged (${args.status}).`,
						},
					],
				};
			},
		},
	];
}

// ── evaluate_script (hidden, selfBootstrap only) ──

function buildEvaluateScriptTool(
	messagesRef: { current: unknown[] },
	allToolsRef: { current: unknown[] },
): ToolDef {
	return {
		name: "evaluate_script",
		availability: "internal",
		description:
			"Execute arbitrary JavaScript/TypeScript code for runtime introspection. " +
			"Only available in self-bootstrap mode.",
		params: {
			projectId: {
				schema: z.string(),
				decl: { kind: "bind", from: "projectId" },
			},
			taskId: {
				schema: z.string(),
				decl: { kind: "bind", from: "taskId" },
			},
			script: {
				schema: z.string().describe("JavaScript/TypeScript code to evaluate"),
				decl: { kind: "explicit" },
			},
		},
		hidden: true,
		handler: async (args) => {
			try {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const tracker = R.getTracker(projectId);
				const session = R.getSession(projectId, taskId);
				const evalContext = {
					messages: messagesRef.current,
					tracker,
					queue: session?.queue,
					projectId,
					taskId,
					sessionId: taskId,
					daemonCtx: R.getDaemonContext(),
					allTools: allToolsRef.current,
				};

				const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
				const fn = new AsyncFunction("ctx", args.script as string);

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
							type: "text",
							text: parts.length > 0 ? parts.join("\n\n") : "(no output)",
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Eval error: ${e instanceof Error ? e.message : String(e)}${e instanceof Error && e.stack ? `\n${e.stack}` : ""}`,
						},
					],
					isError: true,
				};
			}
		},
	};
}

// ── Public API ──

/** Result of createOrchestratorTools — raw tool definitions for provider forwarding. */
export interface OrchestratorToolsResult {
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic is not narrowable here
	toolDefs: ToolDefinition<any>[];
	hasRunningChildren?: () => boolean;
	setMessages?: (msgs: unknown[]) => void;
	setAllTools?: (tools: unknown[]) => void;
}

/**
 * Create orchestrator tools for an agent.
 *
 * @param auth - Opaque auth handle for permission checks
 * @param projectId - Project this agent belongs to
 * @param taskId - Task this agent is running as (null = root)
 * @param selfBootstrap - Enable hidden evaluate_script tool
 */
export function createOrchestratorTools(
	auth: Auth,
	projectId: string,
	taskId: string,
	selfBootstrap?: boolean,
): OrchestratorToolsResult {
	const allDefs = buildAllToolDefs();

	// Convert all ToolDefs to ToolDefinitions via the adapter
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	const toolDefs: ToolDefinition<any>[] = allDefs.map((def) =>
		toToolDefinition(def, auth),
	);

	// evaluate_script (hidden, selfBootstrap only)
	const messagesRef = { current: [] as unknown[] };
	const allToolsRef = { current: [] as unknown[] };
	let setMessages: ((msgs: unknown[]) => void) | undefined;
	let setAllTools: ((tools: unknown[]) => void) | undefined;

	if (selfBootstrap) {
		setMessages = (msgs: unknown[]) => {
			messagesRef.current = msgs;
		};
		setAllTools = (tools: unknown[]) => {
			allToolsRef.current = tools;
		};
		const evalDef = buildEvaluateScriptTool(messagesRef, allToolsRef);
		toolDefs.push(toToolDefinition(evalDef, auth));
	}

	return {
		toolDefs,
		setMessages,
		setAllTools,
		hasRunningChildren: () => {
			const tracker = R.getTracker(projectId);
			if (!tracker) return false;
			return getDescendantIds(tracker, taskId).some(
				(id) => tracker.getTask(id)?.session != null,
			);
		},
	};
}
