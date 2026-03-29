import { join } from "node:path";
import type { Hono } from "hono";
import type { Event } from "../../events.ts";
import type { QueueImage, QueueMessage } from "../../message-queue.ts";
import {
	clearPersistedMessages,
	persistMessage,
} from "../../persistent-queue.ts";
import { buildTaskPrompt, slugify } from "../../task-utils.ts";
import type { TaskStatus } from "../../types.ts";
import { ulid } from "../../ulid.ts";
import { WorktreeManager } from "../../worktree-manager.ts";
import {
	deliverMessage,
	handleInjectMessage,
	runChildAgentInBackground,
} from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import { broadcastTreeUpdate, emitEvent } from "../event-system.ts";
import {
	collectDescendants,
	getEventStore,
	getTracker,
	readProjectMemory,
	stripEventForUI,
} from "../helpers.ts";

/** Notify each ancestor in the parent chain that the user sent a message to a child task. */
async function notifyParentChain(
	ctx: DaemonContext,
	projectId: string,
	taskId: string,
	taskTitle: string,
	messageContent: string,
	statusBeforeDelivery?: string,
): Promise<void> {
	const tracker = await getTracker(ctx, projectId);
	const node = tracker.get(taskId);
	if (!node?.parentId) return;

	let currentId = node.parentId;
	while (currentId) {
		const ancestor = tracker.get(currentId);
		if (!ancestor) break;

		const wasResumed =
			statusBeforeDelivery === "closed" ||
			statusBeforeDelivery === "passed" ||
			statusBeforeDelivery === "failed";
		let content: string;
		if (wasResumed) {
			const details: string[] = [];
			if (node.worktreePath) details.push(`worktree: ${node.worktreePath}`);
			if (node.branch) details.push(`branch: ${node.branch}`);
			const detailStr = details.length > 0 ? ` (${details.join(", ")})` : "";
			content = `User RESUMED ${statusBeforeDelivery} task '${taskTitle}'${detailStr} with message: ${messageContent}`;
		} else {
			content = `User sent a message to child task '${taskTitle}' (${taskId}): ${messageContent}`;
		}

		const notification: QueueMessage = wasResumed
			? {
					source: "task_message",
					id: ulid(),
					fromTaskId: taskId,
					fromTitle: taskTitle,
					content,
				}
			: {
					source: "user_message_forwarded",
					id: ulid(),
					fromTaskId: taskId,
					fromTitle: taskTitle,
					content,
				};

		// Agent queues are on session of tracker nodes
		const ancestorQueue = ancestor.session?.queue;

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

/** Notify running agents in the parent chain that the task tree was modified by the user.
 * Walks from nodeId up through parentId, then to root. Quiet enqueue — doesn't interrupt yield. */
function notifyTreeChange(
	ctx: DaemonContext,
	projectId: string,
	action: "created" | "updated" | "reordered" | "deleted",
	nodeId: string,
	title?: string,
): void {
	const tracker = ctx.trackers.get(projectId);
	if (!tracker) return;

	const msg: QueueMessage = {
		source: "tree_change",
		id: ulid(),
		action,
		nodeId,
		...(title ? { title } : {}),
	};

	// For "updated" actions, also notify the modified node itself (if it has a running agent).
	// The node needs to know its own description/title changed.
	if (action === "updated") {
		const self = tracker.get(nodeId);
		if (self?.session?.queue) {
			try {
				self.session.queue.enqueue(msg, { quiet: true });
			} catch {
				/* queue may be closed */
			}
		}
	}

	// Walk up from the changed node's parent to root, quiet-enqueue to each running agent.
	// The loop naturally reaches root (parentId chain ends at root whose parentId is null).
	const node = tracker.get(nodeId);
	let currentId = node?.parentId;
	while (currentId) {
		const ancestor = tracker.get(currentId);
		if (!ancestor) break;
		const queue = ancestor.session?.queue;
		if (queue) {
			try {
				queue.enqueue(msg, { quiet: true });
			} catch {
				/* queue may be closed */
			}
		}
		if (!ancestor.parentId) break;
		currentId = ancestor.parentId;
	}
}

export function registerTaskRoutes(
	app: Hono,
	ctx: DaemonContext,
	orchestratorSystemPrompt: string,
) {
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
			notifyTreeChange(ctx, project.id, "created", node.id, node.title);
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
		notifyTreeChange(ctx, project.id, "updated", nodeId, node.title);
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
		notifyTreeChange(ctx, project.id, "reordered", nodeId, node.title);
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
				const parentQueue = tracker.get(node.parentId)?.session?.queue;
				if (parentQueue) {
					try {
						parentQueue.enqueue({
							source: "task_message",
							id: ulid(),
							fromTaskId: nodeId,
							fromTitle: node.title,
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

			emitEvent(ctx, project.id, {
				type: "task_started",
				taskId: nodeId,
				title: node.title,
				ts: Date.now(),
			});
			broadcastTreeUpdate(ctx, project.id, tracker);
			notifyParentOfContinue();

			// Persist a message for the agent to drain — header has context
			const memory = readProjectMemory(node.worktreePath ?? project.path);
			const header = buildTaskPrompt(node, tracker, memory);
			const content = body.message
				? body.message
				: "Continue working. Pick up where you left off and complete the task.";
			const parentNode = node.parentId ? tracker.get(node.parentId) : undefined;
			await persistMessage(ctx.config.dataDir, project.id, nodeId, {
				source: "task_message",
				id: ulid(),
				fromTaskId: parentNode?.id ?? "",
				fromTitle: parentNode?.title ?? "User",
				content,
				header,
			});

			// Run async — return immediately so UI updates
			runChildAgentInBackground(ctx, project, tracker, nodeId, body.model);

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

				emitEvent(ctx, project.id, {
					type: "task_started",
					taskId: nodeId,
					title: node.title,
					ts: Date.now(),
				});
				broadcastTreeUpdate(ctx, project.id, tracker);
				notifyParentOfContinue();

				const memory = readProjectMemory(project.path);
				const updatedNode = tracker.get(nodeId);
				const header = buildTaskPrompt(updatedNode ?? node, tracker, memory);
				const content = body.message ?? "Start working on this task.";
				const parentNode2 = node.parentId
					? tracker.get(node.parentId)
					: undefined;
				await persistMessage(ctx.config.dataDir, project.id, nodeId, {
					source: "task_message",
					id: ulid(),
					fromTaskId: parentNode2?.id ?? "",
					fromTitle: parentNode2?.title ?? "User",
					content,
					header,
				});

				runChildAgentInBackground(ctx, project, tracker, nodeId, body.model);

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
			// Close running agent session + queue
			const activeQueue = n.session?.queue;
			if (activeQueue) {
				n.session = undefined;
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
		notifyTreeChange(ctx, project.id, "deleted", nodeId, node.title);
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
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		const eventStore = getEventStore(ctx, project.id);
		const afterCompact = c.req.query("after") === "compact";

		if (afterCompact) {
			const result = eventStore.readFromLastCompactMarker(nodeId);
			const events = result.events.map((e) =>
				stripEventForUI(e as unknown as Record<string, unknown>),
			);
			return c.json({
				events,
				hasOlderEvents: result.hasOlderEvents,
			});
		}

		const events = eventStore
			.read(nodeId)
			.map((e) => stripEventForUI(e as unknown as Record<string, unknown>));
		return c.json({ events, hasOlderEvents: false });
	});

	// Unified message endpoint — handles both root and child nodes.
	// Root nodes delegate to handleInjectMessage (auto-launch, cold-start header, resume detection).
	// Child nodes use direct delivery with two-phase lifecycle.
	app.post("/projects/:id/tasks/:nodeId/message", async (c) => {
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
		// Accept both "content" and "message" field names
		const content = body.content ?? body.message;
		if (!content) {
			return c.json({ error: "content is required" }, 400);
		}

		const tracker = await getTracker(ctx, project.id);
		const isRoot = nodeId === tracker.rootNodeId;

		if (isRoot || !tracker.rootNodeId) {
			// Root node — delegate to handleInjectMessage which handles
			// auto-launch, cold-start header, resume detection, and images.
			const result = await handleInjectMessage(
				ctx,
				project.id,
				content,
				body.images,
				orchestratorSystemPrompt,
			);
			if (!result.ok) {
				return c.json({ error: result.error }, (result.status as 404) ?? 500);
			}
			return c.json({ ok: true, taskId: nodeId });
		}

		// Child node — direct delivery with two-phase lifecycle
		const node = tracker.get(nodeId);
		const taskTitle = node?.title ?? nodeId;
		const statusBeforeDelivery = node?.status;

		const msgId = ulid();

		// Phase 1 of two-phase lifecycle: write + broadcast message at send time.
		// Frontend derives pending state from message events without matching messages_consumed.
		// CRITICAL: body must include `id: msgId` so findUnconsumedMessages can track it
		// for dedup against the persistent queue copy. Without it, the message gets
		// loaded from BOTH JSONL (unconsumed) and persistent queue on resume → duplication.
		const msg: QueueMessage = {
			source: "user",
			id: msgId,
			content,
			...(body.images?.length ? { images: body.images } : {}),
		};
		const userMsgEvent: Event = {
			type: "message",
			id: msgId,
			taskId: nodeId,
			body: msg,
			ts: Date.now(),
		};
		emitEvent(ctx, project.id, userMsgEvent);

		// Unified delivery: enqueue (if running) or persist + launch (if not).
		// Uses same msg object as event body — both must have id for dedup.
		await deliverMessage(ctx, project, nodeId, msg);

		// Notify parent chain that user sent a message to this task (REST-only)
		await notifyParentChain(
			ctx,
			project.id,
			nodeId,
			taskTitle,
			content,
			statusBeforeDelivery,
		);

		return c.json({ ok: true, taskId: nodeId });
	});

	// Clear session (JSONL events) for a single task
	app.post("/projects/:id/tasks/:nodeId/sessions/clear", async (c) => {
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

		// Stop the agent if running for this task
		const activeQueue = node.session?.queue;
		if (activeQueue) {
			node.session = undefined;
			activeQueue.close();
		}

		// If this is the root node, also stop the project's active session
		if (nodeId === tracker.rootNodeId && ctx.activeSessions.has(project.id)) {
			const session = ctx.activeSessions.get(project.id);
			if (session) {
				session.stop();
				ctx.activeSessions.delete(project.id);
			}
		}

		// Clear the JSONL events file for this task
		const eventStore = getEventStore(ctx, project.id);
		eventStore.clear(nodeId);

		// Also clear any persisted (pending) messages for this task
		await clearPersistedMessages(ctx.config.dataDir, project.id, nodeId);

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
		const node = tracker.get(nodeId);
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
			const sourceNode = tracker.get(body.sourceTaskId);
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
