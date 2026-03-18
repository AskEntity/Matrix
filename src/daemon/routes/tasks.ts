import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { slugify } from "../../agent-tools.ts";
import { globalAgentQueues } from "../../message-queue.ts";
import {
	clearPersistedMessages,
	persistMessage,
} from "../../persistent-queue.ts";
import type { TaskStatus } from "../../types.ts";
import { WorktreeManager } from "../../worktree-manager.ts";
import {
	ensureChildAgentRunning,
	runChildAgentInBackground,
} from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import {
	addPendingMessage,
	broadcastEvent,
	broadcastTreeUpdate,
} from "../event-system.ts";
import {
	collectDescendants,
	getTracker,
	readProjectMemory,
} from "../helpers.ts";

/** Notify each ancestor in the parent chain that the user sent a message to a child task. */
async function notifyParentChain(
	ctx: DaemonContext,
	projectId: string,
	taskId: string,
	taskTitle: string,
): Promise<void> {
	const tracker = await getTracker(ctx, projectId);
	const node = tracker.get(taskId);
	if (!node?.parentId) return;

	let currentId = node.parentId;
	while (currentId) {
		const ancestor = tracker.get(currentId);
		if (!ancestor) break;

		const notification = {
			source: "child_report" as const,
			taskId,
			title: taskTitle,
			content: `User sent a message to child task '${taskTitle}' (${taskId})`,
		};

		const ancestorQueue = globalAgentQueues.get(currentId);
		if (ancestorQueue) {
			try {
				ancestorQueue.enqueue(notification);
			} catch {
				/* queue may be closed */
			}
		} else {
			await persistMessage(
				ctx.config.dataDir,
				projectId,
				currentId,
				notification,
			);
		}

		if (!ancestor.parentId) break;
		currentId = ancestor.parentId;
	}
}

/** Notify the running agent (if any) that the task tree was modified by the user. */
function notifyAgentOfTreeChange(
	ctx: DaemonContext,
	projectId: string,
	action: "task_created" | "task_updated" | "task_reordered" | "task_deleted",
	nodeId: string,
	title?: string,
): void {
	// Structured WS event for UI rendering
	broadcastEvent(ctx, projectId, {
		type: "tree_mutation",
		action,
		nodeId,
		title,
	});

	// Non-waking queue message for agent awareness — picked up on next drain(), doesn't interrupt yield
	const session = ctx.activeSessions.get(projectId);
	if (session) {
		try {
			session.queue.enqueueQuiet({
				source: "system",
				content: `Tree ${action.replace("task_", "")}${title ? `: "${title}"` : ""} (${nodeId}). Call get_tree to see the latest state.`,
			});
		} catch {
			/* queue may be closed */
		}
	}
}

export function registerTaskRoutes(app: Hono, ctx: DaemonContext) {
	// Task tree
	app.get("/projects/:id/tasks", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		return c.json({
			nodes: tracker.allNodes(),
			rootNodeId: tracker.rootNodeId,
		});
	});

	app.post("/projects/:id/tasks", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{
			title: string;
			description: string;
			parentId?: string;
			budgetUsd?: number;
		}>();
		if (!body.title) {
			return c.json({ error: "title is required" }, 400);
		}

		const tracker = await getTracker(ctx, project.id);
		const opts: { budgetUsd?: number; editedBy: "user" } = { editedBy: "user" };
		if (body.budgetUsd !== undefined) opts.budgetUsd = body.budgetUsd;
		try {
			// Default to root node as parent if no parentId specified
			const effectiveParentId = body.parentId ?? tracker.rootNodeId;
			const node = effectiveParentId
				? tracker.addChild(
						effectiveParentId,
						body.title,
						body.description ?? "",
						opts,
					)
				: tracker.addTask(body.title, body.description ?? "", opts);
			await tracker.save();
			broadcastTreeUpdate(ctx, project.id, tracker);
			notifyAgentOfTreeChange(
				ctx,
				project.id,
				"task_created",
				node.id,
				node.title,
			);
			return c.json(node, 201);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 409);
		}
	});

	app.patch("/projects/:id/tasks/:nodeId", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		const body = await c.req.json<{
			status?: TaskStatus;
			branch?: string;
			title?: string;
			description?: string;
			draft?: boolean;
			parentId?: string;
			color?: string | null;
		}>();
		if (body.parentId !== undefined) {
			try {
				tracker.reparent(node.id, body.parentId);
			} catch (e) {
				const message = e instanceof Error ? e.message : "Unknown error";
				return c.json({ error: message }, 400);
			}
		}
		if (body.status) {
			tracker.updateStatus(nodeId, body.status, "user");
		}
		if (body.branch) {
			tracker.assignBranch(nodeId, body.branch);
		}
		if (body.title) {
			tracker.updateTitle(node.id, body.title, "user");
		}
		if (body.description !== undefined) {
			tracker.updateDescription(node.id, body.description, "user");
		}
		if (body.draft !== undefined) {
			tracker.updateStatus(node.id, body.draft ? "draft" : "pending", "user");
		}
		if (body.color !== undefined) {
			tracker.updateColor(node.id, body.color, "user");
		}
		await tracker.save();
		broadcastTreeUpdate(ctx, project.id, tracker);
		notifyAgentOfTreeChange(
			ctx,
			project.id,
			"task_updated",
			nodeId,
			node.title,
		);
		return c.json(tracker.get(nodeId));
	});

	app.patch("/projects/:id/tasks/:nodeId/reorder", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		const body = await c.req.json<{ children: string[] }>();
		if (!Array.isArray(body.children)) {
			return c.json({ error: "children must be an array of task IDs" }, 400);
		}
		try {
			tracker.reorderChildren(nodeId, body.children);
		} catch (e) {
			return c.json(
				{ error: e instanceof Error ? e.message : "Unknown error" },
				400,
			);
		}
		await tracker.save();
		broadcastTreeUpdate(ctx, project.id, tracker);
		notifyAgentOfTreeChange(
			ctx,
			project.id,
			"task_reordered",
			nodeId,
			node.title,
		);
		return c.json({ ok: true });
	});

	app.post("/projects/:id/tasks/:nodeId/continue", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		if (
			node.status !== "failed" &&
			node.status !== "stuck" &&
			node.status !== "passed" &&
			node.status !== "closed"
		) {
			return c.json(
				{ error: `Cannot continue task with status: ${node.status}` },
				400,
			);
		}
		const body = await c.req
			.json<{ message?: string; model?: string }>()
			.catch(() => ({ message: undefined, model: undefined }));
		if (body.message) {
			tracker.setMessage(nodeId, body.message);
		}

		/** Notify parent agent (waking) that a child was continued by the user. */
		const notifyParentOfContinue = () => {
			if (node.parentId) {
				const parentQueue = globalAgentQueues.get(node.parentId);
				if (parentQueue) {
					try {
						parentQueue.enqueue({
							source: "child_report",
							taskId: nodeId,
							title: node.title,
							content: `User continued child task "${node.title}" (${nodeId}).`,
						});
					} catch {
						/* queue may be closed */
					}
				}
			}
		};

		// If the task has a worktree, re-run the agent immediately
		if (node.worktreePath) {
			tracker.updateStatus(nodeId, "in_progress");
			await tracker.save();

			broadcastEvent(ctx, project.id, {
				type: "task_started",
				taskId: nodeId,
				title: node.title,
			});
			broadcastTreeUpdate(ctx, project.id, tracker);
			notifyParentOfContinue();

			// sessionId = nodeId: the provider loads session history from <nodeId>.json.
			// If history exists, the agent has full context. If not, include task details.
			const branchReminder = node.branch
				? `\n\nReminder: you are on branch \`${node.branch}\`. Do NOT switch branches.`
				: "";
			const continuePrompt = body.message
				? `${body.message}${branchReminder}`
				: `Continue working. Pick up where you left off and complete the task.${branchReminder}`;

			// Run async — return immediately so UI updates
			runChildAgentInBackground(
				ctx,
				project,
				tracker,
				nodeId,
				continuePrompt,
				body.model,
			);

			return c.json(tracker.get(nodeId));
		}

		// Passed/closed task with no worktree: re-create worktree from main and launch agent
		if (
			(node.status === "passed" || node.status === "closed") &&
			!node.worktreePath
		) {
			try {
				const wtRoot = join(project.path, ".worktrees");
				const wm = new WorktreeManager(project.path, wtRoot);
				const wt = await wm.create(nodeId, slugify(node.title));
				tracker.assignWorktree(nodeId, wt.branch, wt.path);
				tracker.updateStatus(nodeId, "in_progress");
				await tracker.save();

				broadcastEvent(ctx, project.id, {
					type: "task_started",
					taskId: nodeId,
					title: node.title,
				});
				broadcastTreeUpdate(ctx, project.id, tracker);
				notifyParentOfContinue();

				const memory = readProjectMemory(project.path);
				const branchReminder = `\n\nYou are on branch \`${wt.branch}\`. Do NOT switch branches.`;
				const continuePrompt = body.message
					? `${body.message}\n\n## Task: ${node.title}\n${node.description}\n\n## Project Memory\n${memory}${branchReminder}`
					: `Continue working on this task.\n\n## Task: ${node.title}\n${node.description}\n\n## Project Memory\n${memory}${branchReminder}`;

				runChildAgentInBackground(
					ctx,
					project,
					tracker,
					nodeId,
					continuePrompt,
					body.model,
				);

				return c.json(tracker.get(nodeId));
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				return c.json(
					{ error: `Failed to re-create worktree: ${message}` },
					500,
				);
			}
		}

		// No worktree — just reset to pending
		tracker.updateStatus(nodeId, "pending");
		await tracker.save();
		return c.json(tracker.get(nodeId));
	});

	app.delete("/projects/:id/tasks/:nodeId", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}

		// Clean up all resources for this node and all descendants
		const nodesToRemove = collectDescendants(tracker, nodeId);
		const sessionsDir = join(ctx.config.dataDir, "sessions", project.id);

		for (const n of nodesToRemove) {
			// Close running agent queue (must happen before close() to match
			// the "globalAgentQueues only contains live queues" invariant)
			const activeQueue = globalAgentQueues.get(n.id);
			if (activeQueue) {
				globalAgentQueues.delete(n.id);
				activeQueue.close();
			}

			// Remove worktree + branch
			if (n.worktreePath) {
				try {
					const proc = Bun.spawn(
						["git", "worktree", "remove", "--force", n.worktreePath],
						{ cwd: project.path, stdout: "pipe", stderr: "pipe" },
					);
					await proc.exited;
				} catch {
					/* worktree may already be gone */
				}
				if (n.branch) {
					try {
						const proc = Bun.spawn(["git", "branch", "-D", n.branch], {
							cwd: project.path,
							stdout: "pipe",
							stderr: "pipe",
						});
						await proc.exited;
					} catch {
						/* branch may already be gone */
					}
				}
			}

			// Delete session file
			await unlink(join(sessionsDir, `${n.id}.json`)).catch(() => {});
		}

		// Clear persisted messages for all removed tasks
		await Promise.all(
			nodesToRemove.map((n) =>
				clearPersistedMessages(ctx.config.dataDir, project.id, n.id),
			),
		);

		tracker.remove(nodeId);
		await tracker.save();
		broadcastTreeUpdate(ctx, project.id, tracker);
		notifyAgentOfTreeChange(
			ctx,
			project.id,
			"task_deleted",
			nodeId,
			node.title,
		);
		return c.json({ ok: true });
	});

	// Git log for a task branch
	app.get("/projects/:id/tasks/:nodeId/gitlog", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		if (!node.worktreePath || !node.branch) {
			return c.json({ commits: [] });
		}
		try {
			const proc = Bun.spawn(["git", "log", "--oneline", "-20", node.branch], {
				cwd: project.path,
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			const output = await new Response(proc.stdout).text();
			const commits = output
				.trim()
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => {
					const spaceIdx = line.indexOf(" ");
					return {
						hash: spaceIdx >= 0 ? line.slice(0, spaceIdx) : line,
						message: spaceIdx >= 0 ? line.slice(spaceIdx + 1) : "",
					};
				});
			return c.json({ commits });
		} catch {
			return c.json({ commits: [] });
		}
	});

	// Conversation history for a task (from session file)
	app.get("/projects/:id/tasks/:nodeId/conversation", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const tracker = await getTracker(ctx, project.id);
		const node = tracker.get(c.req.param("nodeId"));
		if (!node) return c.json({ error: "Task not found" }, 404);
		// sessionId = nodeId: session file is always <nodeId>.json
		const sessionPath = join(
			ctx.config.dataDir,
			"sessions",
			project.id,
			`${node.id}.json`,
		);
		try {
			const raw = await readFile(sessionPath, "utf-8");
			const params = JSON.parse(raw) as Array<{
				role: string;
				content: unknown;
			}>;
			const messages = params.slice(-100).map((msg) => {
				let content = "";
				let hasToolUse = false;
				const toolNames: string[] = [];
				if (typeof msg.content === "string") {
					content = msg.content;
				} else if (Array.isArray(msg.content)) {
					for (const block of msg.content as Array<{
						type: string;
						text?: string;
						name?: string;
					}>) {
						if (block.type === "text" && block.text)
							content += (content ? "\n" : "") + block.text;
						else if (block.type === "tool_use" && block.name) {
							hasToolUse = true;
							toolNames.push(block.name);
						}
					}
				}
				return {
					role: msg.role,
					content,
					hasToolUse,
					...(toolNames.length ? { toolNames } : {}),
				};
			});
			return c.json({ messages });
		} catch {
			return c.json({ messages: [] });
		}
	});

	// Inject a message into a specific running child agent's queue
	app.post("/projects/:id/tasks/:nodeId/message", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const nodeId = c.req.param("nodeId");
		const body = await c.req.json<{ content: string }>();
		if (!body.content) {
			return c.json({ error: "content is required" }, 400);
		}

		const tracker = await getTracker(ctx, project.id);
		const node = tracker.get(nodeId);
		const taskTitle = node?.title ?? nodeId;

		const queue = globalAgentQueues.get(nodeId);
		if (queue) {
			try {
				queue.enqueue({ source: "user", content: body.content });
				addPendingMessage(ctx, project.id, nodeId, body.content);
				// Notify parent chain that user sent a message to this task
				await notifyParentChain(ctx, project.id, nodeId, taskTitle);
				return c.json({ ok: true, taskId: nodeId });
			} catch {
				// Queue was closed between get() and enqueue() — fall through to persist path
			}
		}

		// No active agent — persist message to disk
		const msg = { source: "user" as const, content: body.content };
		await persistMessage(ctx.config.dataDir, project.id, nodeId, msg);
		addPendingMessage(ctx, project.id, nodeId, body.content);

		// Auto-launch agent for this task (creates worktree if needed).
		// Fire-and-forget — errors are broadcast as events, not thrown to the caller.
		// Use a generic prompt — the real user message is already persisted to disk
		// and will be delivered via the queue (runChildCore loads persisted messages).
		// Passing the user message as the prompt would cause it to appear twice.
		if (node) {
			const hasSession =
				node.status === "passed" ||
				node.status === "closed" ||
				node.status === "failed" ||
				node.status === "stuck";
			const genericPrompt = hasSession
				? "User sent a new message. Resume and check your queue."
				: `Start working on this task.\n\n## Task: ${node.title}\n${node.description ?? ""}`;
			ensureChildAgentRunning(
				ctx,
				project,
				tracker,
				nodeId,
				genericPrompt,
			).catch((e) => {
				broadcastEvent(ctx, project.id, {
					type: "error",
					taskId: nodeId,
					message: `Auto-launch failed: ${e instanceof Error ? e.message : String(e)}`,
				});
			});
		}

		// Notify parent chain that user sent a message to this task
		await notifyParentChain(ctx, project.id, nodeId, taskTitle);

		return c.json({ ok: true, taskId: nodeId, persisted: true });
	});
}
