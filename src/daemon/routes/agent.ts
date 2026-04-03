import type { Hono } from "hono";
import { DEFAULT_MODEL } from "../../config.ts";
import {
	createCompactMessage,
	createUserMessage,
} from "../../queue-message-factory.ts";
import type { SystemPrompt } from "../../system-prompts.ts";
import { moveToBackground } from "../../tools/background.ts";
import { killBackgroundProcess } from "../../tools/bash.ts";
import { isTask } from "../../types.ts";
import {
	handleClarifyResponse,
	runAgentForNode,
	stopAgent,
} from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import { broadcastTreeUpdate, emitEvent } from "../event-system.ts";
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
		// Check if root agent is running via tracker node session
		const tracker = ctx.trackers.get(project.id);
		const running = tracker
			? tracker.getTask(tracker.rootNodeId)?.session != null
			: false;
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
				if (!isTask(node)) continue;
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
		{
			const tracker = ctx.trackers.get(project.id);
			const rootSession = tracker
				? tracker.getTask(tracker.rootNodeId)?.session
				: undefined;
			if (!rootSession) {
				// No active session — reset any orphaned in_progress root node
				// so the UI can reconcile its running state.
				if (tracker?.rootNodeId) {
					const rootNode = tracker.getTask(tracker.rootNodeId);
					if (rootNode && rootNode.status === "in_progress") {
						tracker.updateStatus(tracker.rootNodeId, "failed");
						await tracker.save();
						broadcastTreeUpdate(ctx, project.id, tracker);
					}
				}
				return c.json({ error: "No active agent for this project" }, 404);
			}
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
		const body = await c.req
			.json<{ nodeId?: string }>()
			.catch(() => ({}) as { nodeId?: string });
		const tracker = ctx.trackers.get(project.id);
		const targetNodeId = body.nodeId ?? tracker?.rootNodeId;
		const targetQueue = targetNodeId
			? tracker?.getTask(targetNodeId)?.session?.queue
			: undefined;
		if (!targetQueue) {
			return c.json({ error: "No active agent for this project" }, 404);
		}
		targetQueue.enqueue(createCompactMessage());
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
		{
			const restartTracker = ctx.trackers.get(project.id);
			const rootRunning = restartTracker
				? restartTracker.getTask(restartTracker.rootNodeId)?.session != null
				: false;
			if (!rootRunning) {
				return c.json({ error: "No active agent to restart" }, 404);
			}
		}

		ctx.restartingProjects.add(project.id);
		try {
			await stopAgent(ctx, project.id);

			// Write resume message to JSONL — findUnconsumedMessages recovers it on launch
			const restartTracker = await getTracker(ctx, project.id);
			const restartRootId = restartTracker.rootNodeId;
			if (restartRootId) {
				const restartMsg = createUserMessage(
					"Orchestrator restarted to pick up new config. Continue where you left off.",
				);
				emitEvent(ctx, project.id, {
					type: "message",
					id: restartMsg.id,
					taskId: restartRootId,
					body: restartMsg,
					ts: restartMsg.ts,
				});
			}

			// Relaunch with resume to pick up new config — fire-and-forget
			const restartTracker2 = await getTracker(ctx, project.id);
			restartTracker2.updateStatus(restartTracker2.rootNodeId, "in_progress");
			runAgentForNode(
				ctx,
				project,
				restartTracker2,
				restartTracker2.rootNodeId,
				{
					orchestratorSystemPrompt,
					resume: true,
				},
			).catch((e) => {
				console.error(`[restart] Failed to relaunch:`, e);
			});
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
		{
			const clearTracker = ctx.trackers.get(project.id);
			const rootRunning = clearTracker
				? clearTracker.getTask(clearTracker.rootNodeId)?.session != null
				: false;
			if (rootRunning) {
				await stopAgent(ctx, project.id);
			}
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
		return tracker.getTask(sessionId)?.session;
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

	// Debug: dump live provider messages array (selfBootstrap only)
	app.post("/projects/:id/debug/dump-messages", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const effectiveCfg = await resolveProjectConfig(
			ctx,
			project.path,
			project.id,
		);
		if (!effectiveCfg.selfBootstrap) {
			return c.json({ error: "Only available in selfBootstrap mode" }, 403);
		}
		const tracker = await getTracker(ctx, project.id);
		const { nodeId } = await c.req.json<{ nodeId?: string }>();
		const targetId = nodeId ?? tracker.rootNodeId;
		const node = tracker.getTask(targetId);
		if (!node?.session) {
			return c.json({ error: "No active session for this task" }, 404);
		}
		const { messages, allTools } = node.session;
		if (!messages) {
			return c.json(
				{ error: "Messages not available (agent may not have started)" },
				404,
			);
		}

		// Build hash dump
		const { createHash } = await import("node:crypto");
		const perMessage = (messages as unknown[]).map((m: unknown, i: number) => {
			const json = JSON.stringify(m);
			return {
				idx: i,
				role: (m as { role?: string }).role ?? "unknown",
				hash: createHash("sha256").update(json).digest("hex"),
				len: json.length,
			};
		});
		const fullMsgHash = createHash("sha256")
			.update(JSON.stringify(messages))
			.digest("hex");
		const toolsHash = allTools
			? createHash("sha256").update(JSON.stringify(allTools)).digest("hex")
			: null;

		return c.json({
			taskId: targetId,
			timestamp: new Date().toISOString(),
			msgCount: messages.length,
			fullMsgHash,
			toolsHash,
			toolsCount: allTools?.length ?? 0,
			perMessage,
		});
	});
}
