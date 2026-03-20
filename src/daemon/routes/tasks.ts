import { join } from "node:path";
import type { Hono } from "hono";
import { buildTaskPrompt, slugify } from "../../agent-tools.ts";
import { globalAgentQueues } from "../../message-queue.ts";
import {
	clearPersistedMessages,
	persistMessage,
} from "../../persistent-queue.ts";
import type { TaskStatus } from "../../types.ts";
import { WorktreeManager } from "../../worktree-manager.ts";
import {
	deliverMessage,
	runChildAgentInBackground,
} from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import {
	broadcast,
	broadcastEvent,
	broadcastTreeUpdate,
} from "../event-system.ts";
import {
	collectDescendants,
	getEventStore,
	getTracker,
	normalizeEventForUI,
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

		let ancestorQueue = globalAgentQueues.get(currentId);

		// Root orchestrator's queue is in activeSessions, not globalAgentQueues
		if (!ancestorQueue && !ancestor.parentId) {
			const session = ctx.activeSessions.get(projectId);
			if (session?.queue) {
				ancestorQueue = session.queue;
			}
		}

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
		ts: Date.now(),
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
				ts: Date.now(),
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
					ts: Date.now(),
				});
				broadcastTreeUpdate(ctx, project.id, tracker);
				notifyParentOfContinue();

				const memory = readProjectMemory(project.path, false);
				const updatedNode = tracker.get(nodeId);
				const taskPrompt = buildTaskPrompt(
					updatedNode ?? node,
					tracker,
					memory,
				);
				const continuePrompt = body.message
					? `${body.message}\n\n${taskPrompt}`
					: taskPrompt;

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
		const eventStore = getEventStore(ctx, project.id);

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

			// Delete event JSONL files
			eventStore.clear(n.id);
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

	// Conversation history for a task (from EventStore JSONL)
	app.get("/projects/:id/tasks/:nodeId/conversation", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const tracker = await getTracker(ctx, project.id);
		const node = tracker.get(c.req.param("nodeId"));
		if (!node) return c.json({ error: "Task not found" }, 404);
		try {
			const eventStore = getEventStore(ctx, project.id);
			const events = eventStore.readActive(node.id);
			if (events.length === 0) return c.json({ messages: [] });
			// Convert events to simplified conversation messages
			const messages: Array<{
				role: string;
				content: string;
				hasToolUse: boolean;
				toolNames?: string[];
			}> = [];
			for (const event of events) {
				if (
					event.type === "user_message" ||
					event.type === "compacted_resume"
				) {
					messages.push({
						role: "user",
						content: event.content ?? "",
						hasToolUse: false,
					});
				} else if (event.type === "assistant_text") {
					messages.push({
						role: "assistant",
						content: event.content,
						hasToolUse: false,
					});
				} else if (event.type === "tool_call") {
					// Merge tool_call info into the last assistant message if possible
					const last = messages[messages.length - 1];
					if (last && last.role === "assistant") {
						last.hasToolUse = true;
						if (!last.toolNames) last.toolNames = [];
						last.toolNames.push(event.tool);
					} else {
						messages.push({
							role: "assistant",
							content: "",
							hasToolUse: true,
							toolNames: [event.tool],
						});
					}
				}
			}
			return c.json({ messages: messages.slice(-100) });
		} catch {
			return c.json({ messages: [] });
		}
	});

	// JSONL events for a specific task
	app.get("/projects/:id/tasks/:nodeId/events", async (c) => {
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
		const eventStore = getEventStore(ctx, project.id);
		const events = eventStore
			.read(nodeId)
			.map((e) => normalizeEventForUI(e, nodeId));
		return c.json({ events });
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

		// Unified delivery: enqueue (if running) or persist + launch (if not)
		const deliveryResult = await deliverMessage(ctx, project, nodeId, {
			source: "user",
			content: body.content,
		});
		if (deliveryResult === "persisted") {
			// Message went to disk — broadcast as pending until agent loads it
			broadcast(ctx.wsClients, project.id, {
				type: "pending_messages",
				projectId: project.id,
				messages: [{ text: body.content, timestamp: Date.now() }],
			});
		}

		// Notify parent chain that user sent a message to this task (REST-only)
		await notifyParentChain(ctx, project.id, nodeId, taskTitle);

		return c.json({ ok: true, taskId: nodeId });
	});
}
