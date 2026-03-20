import type { Hono } from "hono";
import { DEFAULT_MODEL } from "../../config.ts";
import type { QueueImage } from "../../message-queue.ts";
import { globalAgentQueues } from "../../message-queue.ts";
import {
	handleClarifyResponse,
	handleInjectMessage,
	handleOrchestrate,
	launchAgent,
	stopAgent,
} from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import { broadcastTreeUpdate } from "../event-system.ts";
import {
	getProjectProvider,
	getSessionStore,
	getTracker,
	pruneSessionFiles,
	resolveProjectConfig,
} from "../helpers.ts";

export function registerAgentRoutes(
	app: Hono,
	ctx: DaemonContext,
	orchestratorSystemPrompt: string,
) {
	// Agent-driven orchestration: fire-and-forget, observe via WebSocket
	app.post("/projects/:id/orchestrate/agent", async (c) => {
		const body = await c.req.json<{
			prompt: string;
			resume?: boolean;
			model?: string;
			childModel?: string;
		}>();
		if (!body.prompt && !body.resume) {
			return c.json({ error: "prompt is required" }, 400);
		}

		const result = await handleOrchestrate(
			ctx,
			c.req.param("id"),
			body.prompt,
			body,
			orchestratorSystemPrompt,
		);
		if (!result.ok) {
			return c.json({ error: result.error }, result.status as 404);
		}
		return c.json({ status: "running", projectId: c.req.param("id") });
	});

	// Start agent by project path (auto-creates project if needed)
	app.post("/agents/start", async (c) => {
		if (!ctx.startupReady) {
			return c.json({ error: "Server starting up, please wait..." }, 503);
		}
		const body = await c.req.json<{
			path: string;
			prompt: string;
			model?: string;
			childModel?: string;
		}>();
		if (!body.path) {
			return c.json({ error: "path is required" }, 400);
		}
		if (!body.prompt) {
			return c.json({ error: "prompt is required" }, 400);
		}

		const project = await ctx.pm.ensureProject(body.path);

		if (ctx.restartingProjects.has(project.id)) {
			return c.json({ error: "Agent restarting, please wait" }, 409);
		}

		// Agent already running — enqueue the prompt as a user message
		const existingSession = ctx.activeSessions.get(project.id);
		if (existingSession) {
			try {
				existingSession.queue.enqueue({
					source: "user",
					content: body.prompt,
				});
			} catch {
				return c.json({ error: "Queue closed" }, 409);
			}
			return c.json({ status: "running", projectId: project.id });
		}

		await getTracker(ctx, project.id);
		await launchAgent(ctx, project, body, orchestratorSystemPrompt);
		return c.json({ status: "running", projectId: project.id });
	});

	// Agent status
	app.get("/projects/:id/agent", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const session = ctx.activeSessions.get(project.id);
		const effectiveCfg = await resolveProjectConfig(
			ctx,
			project.path,
			project.id,
		);
		const provider = getProjectProvider(ctx, effectiveCfg);
		const model = effectiveCfg.model ?? DEFAULT_MODEL;
		return c.json({
			running: !!session,
			provider: provider.name,
			model,
		});
	});

	// Agent idle/active status for all tasks in a project
	app.get("/projects/:id/agent/status", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const idle: string[] = [];
		const active: string[] = [];
		const tracker = ctx.trackers.get(project.id);
		if (tracker) {
			for (const node of tracker.allNodes()) {
				const queue = globalAgentQueues.get(node.id);
				if (queue) {
					if (queue.idle) {
						idle.push(node.id);
					} else {
						active.push(node.id);
					}
				}
			}
			// Also check the root/orchestrator session
			const session = ctx.activeSessions.get(project.id);
			if (session && tracker.rootNodeId) {
				const rootId = tracker.rootNodeId;
				if (!active.includes(rootId) && !idle.includes(rootId)) {
					if (session.queue.idle) {
						idle.push(rootId);
					} else {
						active.push(rootId);
					}
				}
			}
		}
		return c.json({ idle, active });
	});

	// Stop a running agent
	app.post("/projects/:id/stop", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		if (!ctx.activeSessions.has(project.id)) {
			// No active session — reset any orphaned in_progress root node
			// so the UI can reconcile its running state.
			const tracker = ctx.trackers.get(project.id);
			if (tracker?.rootNodeId) {
				const rootNode = tracker.get(tracker.rootNodeId);
				if (rootNode && rootNode.status === "in_progress") {
					tracker.updateStatus(tracker.rootNodeId, "failed");
					await tracker.save();
					broadcastTreeUpdate(ctx, project.id, tracker);
				}
			}
			return c.json({ error: "No active agent for this project" }, 404);
		}
		await stopAgent(ctx, project.id);
		return c.json({ ok: true });
	});

	// Trigger manual compaction on a running session
	app.post("/projects/:id/compact", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const session = ctx.activeSessions.get(project.id);
		if (!session) {
			return c.json({ error: "No active agent for this project" }, 404);
		}
		session.queue.enqueue({ source: "compact" });
		return c.json({ compacting: true });
	});

	// Restart orchestrator: stop current session, relaunch with resume:true
	app.post("/projects/:id/restart", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		if (ctx.restartingProjects.has(project.id)) {
			return c.json({ error: "Restart already in progress" }, 409);
		}
		if (!ctx.activeSessions.has(project.id)) {
			return c.json({ error: "No active agent to restart" }, 404);
		}

		ctx.restartingProjects.add(project.id);
		try {
			await stopAgent(ctx, project.id);

			// Relaunch with resume to pick up new config
			await launchAgent(
				ctx,
				project,
				{
					prompt:
						"Orchestrator restarted to pick up new config. Continue where you left off.",
					resume: true,
				},
				orchestratorSystemPrompt,
			);
			return c.json({ ok: true });
		} finally {
			ctx.restartingProjects.delete(project.id);
		}
	});

	// Inject a message into a running agent
	app.post("/projects/:id/message", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{
			message: string;
			images?: QueueImage[];
		}>();
		if (!body.message) {
			return c.json({ error: "message is required" }, 400);
		}

		const result = await handleInjectMessage(
			ctx,
			project.id,
			body.message,
			body.images,
			orchestratorSystemPrompt,
		);
		if (!result.ok) {
			return c.json({ error: result.error }, result.status as 404);
		}
		return c.json({ ok: true });
	});

	// Respond to a pending clarification request
	app.post("/projects/:id/clarify", async (c) => {
		const projectId = c.req.param("id");
		const body = await c.req.json<{
			taskId: string;
			answer: string;
			clarificationId?: string;
		}>();
		if (!body.taskId || !body.answer) {
			return c.json({ error: "taskId and answer are required" }, 400);
		}

		const result = await handleClarifyResponse(
			ctx,
			projectId,
			body.taskId,
			body.answer,
			body.clarificationId,
		);
		if (!result.ok) {
			return c.json({ error: result.error }, result.status as 404);
		}
		return c.json({ ok: true });
	});

	// Clear session history for a project (useful when starting fresh after restart)
	app.post("/projects/:id/sessions/clear", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		if (ctx.activeSessions.has(project.id)) {
			await stopAgent(ctx, project.id);
		}
		const store = getSessionStore(ctx, project.id);
		await store.clearAll();
		// JSONL event files live alongside session files in the sessions dir —
		// clearAll() removes both .json and .events.jsonl files.
		// Also clear the in-memory EventStore cache so it re-creates from disk.
		ctx.eventStores.delete(project.id);
		const tracker = ctx.trackers.get(project.id);
		if (tracker) {
			// Broadcast tree so connected WS clients re-render with current nodes
			broadcastTreeUpdate(ctx, project.id, tracker);
		}
		return c.json({ cleared: true });
	});

	// Prune old session files (keep only the most recent N)
	app.post("/projects/:id/sessions/prune", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);

		const body = await c.req
			.json<{ keepCount?: number }>()
			.catch(() => ({}) as { keepCount?: number });
		const keepCount = body?.keepCount ?? 10;

		const result = await pruneSessionFiles(ctx, project.id, keepCount);
		return c.json(result);
	});
}
