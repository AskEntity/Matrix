import { join } from "node:path";
import type { Hono } from "hono";
import type { QueueImage } from "../../message-queue.ts";
import {
	createTaskMessage,
	createTreeChange,
	createUserMessage,
	createUserMessageForwarded,
} from "../../queue-message-factory.ts";
// SystemPrompt import removed — scope opts come from ctx.scopeOpts
import {
	createTaskOp,
	deleteTaskOp,
	reorderTasksOp,
	TaskOperationError,
	updateTaskOp,
} from "../../task-operations.ts";
import { slugify } from "../../task-utils.ts";
import { cleanupSessionBackgroundProcesses } from "../../tools/index.ts";
import { isTask } from "../../types.ts";
import { WorktreeManager } from "../../worktree-manager.ts";
import {
	deliverMessage,
	runAgentForNode,
	stopTask,
} from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import { broadcastTreeUpdate, emitEvent } from "../event-system.ts";
import {
	getEventStore,
	getTracker,
	// readProjectMemory removed — work_context hook handles context injection
	stripEventForUI,
} from "../helpers.ts";

/** Notify each ancestor in the parent chain that the user sent a message to a child task. */
async function notifyParentChain(
	ctx: DaemonContext,
	project: { id: string; path: string },
	taskId: string,
	taskTitle: string,
	messageContent: string,
	statusBeforeDelivery?: string,
): Promise<void> {
	const tracker = await getTracker(ctx, project.id);
	const node = tracker.getTask(taskId);
	if (!node?.parentId) return;

	const wasResumed =
		statusBeforeDelivery === "closed" ||
		statusBeforeDelivery === "verify" ||
		statusBeforeDelivery === "failed";

	// Walk parent chain using tracker.get() to traverse through folders
	let currentId: string | null = node.parentId;
	while (currentId) {
		const ancestor = tracker.get(currentId);
		if (!ancestor) break;

		// Only deliver to task nodes — folders have no queue/session
		if (isTask(ancestor)) {
			// Content is always the user's raw message — metadata goes in XML attributes
			const notification = createUserMessageForwarded(
				taskId,
				taskTitle,
				messageContent,
				wasResumed ? { resumed: true } : undefined,
			);

			// Quiet delivery — don't auto-launch stopped agents for notifications
			await deliverMessage(ctx, project, currentId, notification, {
				quiet: true,
			});
		}

		if (!ancestor.parentId) break;
		currentId = ancestor.parentId;
	}
}

/** Notify agents in the parent chain that the task tree was modified by the user.
 * Walks from nodeId up through parentId, then to root. Quiet — doesn't auto-launch. */
function notifyTreeChange(
	ctx: DaemonContext,
	project: { id: string; path: string },
	action: "created" | "updated" | "reordered" | "deleted",
	nodeId: string,
	title?: string,
): void {
	const tracker = ctx.trackers.get(project.id);
	if (!tracker) return;

	// For "updated" actions, also notify the modified node itself.
	if (action === "updated") {
		const msg = createTreeChange(action, nodeId, title);
		deliverMessage(ctx, project, nodeId, msg, { quiet: true });
	}

	// Walk up from the changed node's parent to root, traversing through folders.
	const node = tracker.get(nodeId);
	let currentId = node?.parentId;
	while (currentId) {
		const ancestor = tracker.get(currentId);
		if (!ancestor) break;
		// Only deliver to task nodes — folders have no queue/session
		if (isTask(ancestor)) {
			const msg = createTreeChange(action, nodeId, title);
			deliverMessage(ctx, project, currentId, msg, { quiet: true });
		}
		if (!ancestor.parentId) break;
		currentId = ancestor.parentId;
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
			folder?: boolean;
		}>();
		if (!body.title) {
			return c.json({ error: "title is required" }, 400);
		}
		if (!body.parentId) {
			return c.json({ error: "parentId is required" }, 400);
		}

		const tracker = await getTracker(ctx, project.id);

		// Folder creation — minimal node, zero lifecycle
		if (body.folder) {
			const folder = tracker.addFolder(body.title, body.parentId);
			await tracker.save();
			broadcastTreeUpdate(ctx, project.id, tracker);
			return c.json(folder, 201);
		}

		try {
			const node = await createTaskOp(
				tracker,
				{
					title: body.title,
					description: body.description ?? "",
					parentId: body.parentId,
					budgetUsd: body.budgetUsd,
				},
				"user",
				{
					broadcastTree: () => broadcastTreeUpdate(ctx, project.id, tracker),
					notifyTreeChange: (action, nodeId, title) =>
						notifyTreeChange(ctx, project, action, nodeId, title),
					projectPath: project.path,
				},
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
		const body = await c.req.json<{
			status?: string;
			branch?: string;
			title?: string;
			description?: string;
			draft?: boolean;
			parentId?: string;
			color?: string | null;
		}>();

		const node = tracker.getTask(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}

		try {
			// REST-only: branch assignment (agents don't manually set branches)
			if (body.branch !== undefined) {
				tracker.assignBranch(nodeId, body.branch);
			}

			const node = await updateTaskOp(
				tracker,
				nodeId,
				{
					status: body.status as
						| "draft"
						| "pending"
						| "in_progress"
						| "verify"
						| "failed"
						| "closed"
						| undefined,
					title: body.title,
					description: body.description,
					draft: body.draft,
					parentId: body.parentId,
					color: body.color,
				},
				"user",
				{
					broadcastTree: () => broadcastTreeUpdate(ctx, project.id, tracker),
					notifyTreeChange: (action, nId, title) =>
						notifyTreeChange(ctx, project, action, nId, title),
					notifyTargetNode: (action, nId, title) => {
						const msg = createTreeChange(action, nId, title);
						deliverMessage(ctx, project, nId, msg, { quiet: true });
					},
					projectPath: project.path,
				},
			);

			return c.json(node);
		} catch (e) {
			if (e instanceof TaskOperationError) {
				return c.json({ error: e.message }, 400);
			}
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 400);
		}
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
			return c.json({ error: "Node not found" }, 404);
		}
		const body = await c.req.json<{ children: string[] }>();
		if (!Array.isArray(body.children)) {
			return c.json({ error: "children must be an array of task IDs" }, 400);
		}
		try {
			await reorderTasksOp(tracker, nodeId, body.children, "user", {
				broadcastTree: () => broadcastTreeUpdate(ctx, project.id, tracker),
				notifyTreeChange: (action, nId, title) =>
					notifyTreeChange(ctx, project, action, nId, title),
			});
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 400);
		}
	});

	app.post("/projects/:id/tasks/:nodeId/continue", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.getTask(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		if (
			node.status !== "failed" &&
			node.status !== "verify" &&
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
		/** Notify parent chain that a child was continued/resumed by the user. */
		const notifyParentOfContinue = () => {
			const content = body.message ?? "Continue working.";
			notifyParentChain(
				ctx,
				project,
				nodeId,
				node.title ?? nodeId,
				content,
				node.status,
			).catch(() => {
				/* delivery may fail if no project */
			});
		};

		// If the task has a worktree, re-run the agent immediately
		if (node.worktreePath) {
			tracker.updateStatus(nodeId, "in_progress");
			await tracker.save();

			broadcastTreeUpdate(ctx, project.id, tracker);
			notifyParentOfContinue();

			// Persist a message for the agent to drain — work_context injected by hook
			const content = body.message
				? body.message
				: "Continue working. Pick up where you left off and complete the task.";
			// Use getTaskAbove to skip folders — folders have no identity for messages
			const taskAbove = tracker.getTaskAbove(nodeId);
			const continueMsg = createTaskMessage(
				taskAbove?.id ?? "",
				taskAbove?.title ?? "User",
				content,
			);
			emitEvent(ctx, project.id, {
				type: "message",
				id: continueMsg.id,
				taskId: nodeId,
				body: continueMsg,
				ts: continueMsg.ts,
			});

			// Run async — return immediately so UI updates
			const scopeOpts = ctx.scopeOpts.get(project.id);
			if (scopeOpts) {
				runAgentForNode(ctx, project, tracker, nodeId, {
					...scopeOpts,
					model: body.model,
				});
			}

			return c.json(tracker.getTask(nodeId));
		}

		// Verify/closed task with no worktree: re-create worktree and launch agent
		if (
			(node.status === "verify" || node.status === "closed") &&
			!node.worktreePath
		) {
			try {
				// Use getTaskAbove to skip folders — folders have no branch
				const taskAboveForBranch = tracker.getTaskAbove(nodeId);
				const baseBranch = taskAboveForBranch?.branch;
				if (!baseBranch) {
					return c.json(
						{ error: "Cannot create worktree — parent has no branch assigned" },
						400,
					);
				}
				const wtRoot = join(project.path, ".worktrees");
				const wm = new WorktreeManager(project.path, wtRoot);
				const wt = await wm.create(nodeId, slugify(node.title), baseBranch);
				tracker.assignWorktree(nodeId, wt.branch, wt.path);
				tracker.updateStatus(nodeId, "in_progress");
				await tracker.save();

				broadcastTreeUpdate(ctx, project.id, tracker);
				notifyParentOfContinue();

				const content = body.message ?? "Start working on this task.";
				const taskAbove2 = tracker.getTaskAbove(nodeId);
				const continueMsg2 = createTaskMessage(
					taskAbove2?.id ?? "",
					taskAbove2?.title ?? "User",
					content,
				);
				emitEvent(ctx, project.id, {
					type: "message",
					id: continueMsg2.id,
					taskId: nodeId,
					body: continueMsg2,
					ts: continueMsg2.ts,
				});

				const scopeOpts2 = ctx.scopeOpts.get(project.id);
				if (scopeOpts2) {
					runAgentForNode(ctx, project, tracker, nodeId, {
						...scopeOpts2,
						model: body.model,
					});
				}

				return c.json(tracker.getTask(nodeId));
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
		return c.json(tracker.getTask(nodeId));
	});

	app.delete("/projects/:id/tasks/:nodeId", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");

		try {
			const eventStore = getEventStore(ctx, project.id);
			const wtRoot = join(project.path, ".worktrees");
			const wm = new WorktreeManager(project.path, wtRoot);
			await deleteTaskOp(tracker, nodeId, "user", {
				broadcastTree: () => broadcastTreeUpdate(ctx, project.id, tracker),
				notifyTreeChange: (action, nId, title) =>
					notifyTreeChange(ctx, project, action, nId, title),
				removeWorktree: (id, slug) => wm.remove(id, slug),
				clearEventStore: (id) => eventStore.clear(id),
			});
			return c.json({ ok: true });
		} catch (e) {
			if (e instanceof TaskOperationError) {
				const status = e.message.includes("not found") ? 404 : 400;
				return c.json({ error: e.message }, status);
			}
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 500);
		}
	});

	// Git log for a task branch
	app.get("/projects/:id/tasks/:nodeId/gitlog", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.getTask(nodeId);
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
		} catch (e) {
			console.warn(`[tasks] Failed to get commits for ${nodeId}:`, e);
			return c.json({ commits: [] });
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
		const node = tracker.getTask(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		const eventStore = getEventStore(ctx, project.id);
		const afterCompact = c.req.query("after") === "compact";

		// Helper: append synthetic partial assistant_text if actively streaming
		const appendPartialText = (events: Record<string, unknown>[]) => {
			const partialText = ctx.streamingText.get(nodeId);
			if (partialText) {
				events.push({
					type: "assistant_text",
					content: partialText,
					taskId: nodeId,
					ts: Date.now(),
					partial: true,
				});
			}
			return events;
		};

		if (afterCompact) {
			const result = eventStore.readFromLastCompactMarker(nodeId);
			const events = result.events.map((e) =>
				stripEventForUI(e as unknown as Record<string, unknown>),
			);
			return c.json({
				events: appendPartialText(events),
				hasOlderEvents: result.hasOlderEvents,
			});
		}

		const events = eventStore
			.read(nodeId)
			.map((e) => stripEventForUI(e as unknown as Record<string, unknown>));
		return c.json({ events: appendPartialText(events), hasOlderEvents: false });
	});

	// THE single message endpoint for all tasks — root and child, one code path.
	app.post("/projects/:id/tasks/:nodeId/message", async (c) => {
		if (!ctx.startupReady) {
			return c.json({ error: "Server starting up, please wait..." }, 503);
		}
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const nodeId = c.req.param("nodeId");
		const body = await c.req.json<{
			content?: string;
			message?: string;
			images?: QueueImage[];
		}>();
		const content = body.content ?? body.message;
		if (!content) {
			return c.json({ error: "content is required" }, 400);
		}

		const tracker = await getTracker(ctx, project.id);
		const node = tracker.getTask(nodeId);
		const statusBeforeDelivery = node?.status;

		// No header needed — work_context is injected by enqueue hook on fresh sessions.
		const msg = createUserMessage(content, { images: body.images });

		// Single delivery path: JSONL persistence + queue delivery + auto-launch.
		// Scope opts looked up from ctx.scopeOpts by deliverMessage.
		await deliverMessage(ctx, project, nodeId, msg);

		// Notify parent chain for non-root nodes (user sending to child task)
		if (node?.parentId) {
			await notifyParentChain(
				ctx,
				project,
				nodeId,
				node.title ?? nodeId,
				content,
				statusBeforeDelivery,
			);
		}

		return c.json({ ok: true, taskId: nodeId });
	});

	// Stop a running agent for a specific task
	app.post("/projects/:id/tasks/:nodeId/stop", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const nodeId = c.req.param("nodeId");
		const tracker = await getTracker(ctx, project.id);
		const node = tracker.getTask(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		const stopped = await stopTask(ctx, project.id, nodeId);
		if (!stopped) {
			return c.json({ error: "No running agent for this task" }, 404);
		}
		return c.json({ ok: true });
	});

	// Clear session (JSONL events) for a single task
	app.post("/projects/:id/tasks/:nodeId/sessions/clear", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.getTask(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}

		// Stop the agent if running for this task
		if (node.session) {
			node.session.queue.close();
			node.session.abortController.abort();
			cleanupSessionBackgroundProcesses(node.session.backgroundProcesses);
			node.session = undefined;
		}

		// Clear the JSONL events file for this task
		const eventStore = getEventStore(ctx, project.id);
		eventStore.clear(nodeId);

		// Broadcast tree update so UI reflects any status changes
		broadcastTreeUpdate(ctx, project.id, tracker);

		return c.json({ cleared: true, taskId: nodeId });
	});

	// Fork context from a source task into this task
	app.post("/projects/:id/tasks/:nodeId/fork", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(ctx, project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.getTask(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}

		const body = await c.req.json<{ sourceTaskId: string }>();
		if (!body.sourceTaskId) {
			return c.json({ error: "sourceTaskId is required" }, 400);
		}

		const eventStore = getEventStore(ctx, project.id);

		// Validate source has session data
		if (!eventStore.has(body.sourceTaskId)) {
			return c.json(
				{
					error: `Source task "${body.sourceTaskId}" has no session data to fork from.`,
				},
				400,
			);
		}

		// Validate target doesn't already have session data
		if (eventStore.has(nodeId)) {
			return c.json(
				{
					error: `Target task "${nodeId}" already has session data. Clear the session first.`,
				},
				409,
			);
		}

		try {
			const result = await eventStore.copySessionFrom(
				body.sourceTaskId,
				nodeId,
				{
					targetTitle: node.title,
					targetDescription: node.description,
				},
			);
			const sourceNode = tracker.getTask(body.sourceTaskId);
			return c.json({
				ok: true,
				taskId: nodeId,
				sourceTaskId: body.sourceTaskId,
				sourceTitle: sourceNode?.title ?? body.sourceTaskId,
				eventCount: result.eventCount,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 500);
		}
	});
}
