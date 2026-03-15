import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { globalAgentQueues } from "../../message-queue.ts";
import type { TaskStatus } from "../../types.ts";
import { runChildAgentInBackground } from "../agent-lifecycle.ts";
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

/** Notify the running agent (if any) that the task tree was modified by the user. */
function notifyAgentOfTreeChange(ctx: DaemonContext, projectId: string): void {
	const session = ctx.activeSessions.get(projectId);
	if (session) {
		try {
			session.queue.enqueue({
				source: "user",
				content:
					"[TREE UPDATED] The task tree was modified by the user via the Web UI. Call get_tree to see the latest state.",
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
			notifyAgentOfTreeChange(ctx, project.id);
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
			color?: string | null;
		}>();
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
			tracker.updateDraft(node.id, body.draft, "user");
		}
		if (body.color !== undefined) {
			tracker.updateColor(node.id, body.color, "user");
		}
		await tracker.save();
		broadcastTreeUpdate(ctx, project.id, tracker);
		notifyAgentOfTreeChange(ctx, project.id);
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
		notifyAgentOfTreeChange(ctx, project.id);
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
		if (node.status !== "failed" && node.status !== "stuck") {
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

			// If we have a session, the agent already has full context in its history.
			// Just send the user's message (or a simple continue instruction).
			// If no session, include full task context since it's a fresh start.
			const branchReminder = node.branch
				? `\n\nReminder: you are on branch \`${node.branch}\`. Do NOT switch branches.`
				: "";
			let continuePrompt: string;
			if (node.sessionId) {
				continuePrompt = body.message
					? `${body.message}${branchReminder}`
					: `Continue working. Pick up where you left off and complete the task.${branchReminder}`;
			} else {
				const memory = readProjectMemory(project.path);
				continuePrompt = body.message
					? `${body.message}\n\n## Task: ${node.title}\n${node.description}\n\n## Project Memory\n${memory}${branchReminder}`
					: `Continue working on this task.\n\n## Task: ${node.title}\n${node.description}\n\n## Project Memory\n${memory}${branchReminder}`;
			}

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

		// Clean up worktrees for this node and all descendants
		const nodesToRemove = collectDescendants(tracker, nodeId);
		for (const n of nodesToRemove) {
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
		}

		tracker.remove(nodeId);
		await tracker.save();
		broadcastTreeUpdate(ctx, project.id, tracker);
		notifyAgentOfTreeChange(ctx, project.id);
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
		if (!node.sessionId) return c.json({ messages: [] });
		const sessionPath = join(
			ctx.config.dataDir,
			"sessions",
			project.id,
			`${node.sessionId}.json`,
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

		const queue = globalAgentQueues.get(nodeId);
		if (!queue) {
			return c.json({ error: "No active agent for this task" }, 404);
		}

		try {
			queue.enqueue({ source: "user", content: body.content });
		} catch {
			return c.json({ error: "Queue closed" }, 409);
		}
		addPendingMessage(ctx, project.id, nodeId, body.content);
		return c.json({ ok: true, taskId: nodeId });
	});
}
