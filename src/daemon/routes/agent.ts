import type { Hono } from "hono";
import { DEFAULT_MODEL } from "../../config.ts";
import { persistMessage } from "../../persistent-queue.ts";
import type { SystemPrompt } from "../../system-prompts.ts";
import { cancelAwait, moveToBackground } from "../../tools/background.ts";
import { killBackgroundProcess } from "../../tools/bash.ts";
import { ulid } from "../../ulid.ts";
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
	getEventStore,
	getProjectProvider,
	getTracker,
	pruneSessionFiles,
	resolveProjectConfig,
} from "../helpers.ts";

export function registerAgentRoutes(
	app: Hono,
	ctx: DaemonContext,
	orchestratorSystemPrompt: SystemPrompt,
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

	// Start agent by project path (auto-creates project if needed).
	// Thin wrapper: ensures project exists, then delegates to handleInjectMessage
	// which is the single code path for delivering user messages to the root agent.
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

		// Delegate to the single message delivery path
		const result = await handleInjectMessage(
			ctx,
			project.id,
			body.prompt,
			undefined,
			orchestratorSystemPrompt,
		);
		if (!result.ok) {
			return c.json({ error: result.error }, result.status as 404);
		}
		return c.json({ status: "running", projectId: project.id });
	});

	// Agent status
	app.get("/projects/:id/agent", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const effectiveCfg = await resolveProjectConfig(
			ctx,
			project.path,
			project.id,
		);
		const provider = getProjectProvider(ctx, effectiveCfg);
		const model = effectiveCfg.model ?? DEFAULT_MODEL;
		// Check if root agent is running via unified registry
		const running = ctx.activeSessions.has(project.id);
		return c.json({
			running,
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
			// All agent queues are on session of tracker nodes
			for (const node of tracker.allNodes()) {
				const queue = node.session?.queue;
				if (queue) {
					if (queue.idle) {
						idle.push(node.id);
					} else {
						active.push(node.id);
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
		const tracker = ctx.trackers.get(project.id);
		const rootNodeId = tracker?.rootNodeId;
		const rootQueue = rootNodeId
			? tracker?.get(rootNodeId)?.session?.queue
			: undefined;
		if (!rootQueue) {
			return c.json({ error: "No active agent for this project" }, 404);
		}
		rootQueue.enqueue({ source: "compact", id: ulid() });
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

			// Persist a resume message — no header needed, agent has context from JSONL
			const restartTracker = await getTracker(ctx, project.id);
			const restartRootId = restartTracker.rootNodeId;
			if (restartRootId) {
				await persistMessage(ctx.config.dataDir, project.id, restartRootId, {
					source: "user",
					id: ulid(),
					content:
						"Orchestrator restarted to pick up new config. Continue where you left off.",
				});
			}

			// Relaunch with resume to pick up new config
			await launchAgent(
				ctx,
				project,
				{ resume: true },
				orchestratorSystemPrompt,
			);
			return c.json({ ok: true });
		} finally {
			ctx.restartingProjects.delete(project.id);
		}
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
		const eventStore = getEventStore(ctx, project.id);
		await eventStore.clearAll();
		// Re-create the EventStore cache entry so it sees the cleaned directory
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

	// ── Background process management endpoints ──

	// Helper: look up session from tracker by sessionId (= taskId)
	const getSessionFromTracker = async (
		projectId: string,
		sessionId: string,
	) => {
		const tracker = await getTracker(ctx, projectId);
		return tracker.get(sessionId)?.session;
	};

	// Move a foreground execution to background
	app.post("/projects/:id/background/move", async (c) => {
		const projectId = c.req.param("id");
		const body = await c.req.json<{
			sessionId: string;
			execId: string;
		}>();
		if (!body.sessionId || !body.execId) {
			return c.json({ error: "sessionId and execId are required" }, 400);
		}
		const session = await getSessionFromTracker(projectId, body.sessionId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		const result = moveToBackground(
			session.foregroundExecutions,
			body.sessionId,
			body.execId,
		);
		if (result === null) {
			return c.json(
				{ error: "Foreground execution not found or already completed" },
				404,
			);
		}
		return c.json({ ok: true, execId: result });
	});

	// Kill a background process
	app.post("/projects/:id/background/:bgId/kill", async (c) => {
		const projectId = c.req.param("id");
		const bgId = c.req.param("bgId");
		const body = await c.req
			.json<{ sessionId: string }>()
			.catch(() => ({}) as { sessionId: string });
		if (!body?.sessionId) {
			return c.json({ error: "sessionId is required" }, 400);
		}
		const session = await getSessionFromTracker(projectId, body.sessionId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		const result = killBackgroundProcess(session.backgroundProcesses, bgId);
		if (result === null) {
			return c.json({ error: `Background process ${bgId} not found` }, 404);
		}
		return c.json({ ok: true, message: result });
	});

	// Cancel an active await on a background process
	app.post("/projects/:id/background/:bgId/cancel-await", async (c) => {
		const bgId = c.req.param("bgId");
		const body = await c.req
			.json<{ sessionId: string }>()
			.catch(() => ({}) as { sessionId: string });
		if (!body?.sessionId) {
			return c.json({ error: "sessionId is required" }, 400);
		}
		const result = cancelAwait(body.sessionId, bgId);
		if (result === null) {
			return c.json({ error: `Background process ${bgId} not found` }, 404);
		}
		return c.json({ ok: true, message: result });
	});
}
