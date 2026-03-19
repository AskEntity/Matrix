import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { globalAgentQueues } from "../../message-queue.ts";
import { stopAgent } from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import { getPendingClarifications, loadEventHistory } from "../event-system.ts";

export function registerProjectRoutes(app: Hono, ctx: DaemonContext) {
	// Projects CRUD
	app.post("/projects", async (c) => {
		const body = await c.req.json<{ path: string }>();
		if (!body.path) {
			return c.json({ error: "path is required" }, 400);
		}
		try {
			const project = await ctx.pm.init(body.path);
			return c.json(project, 201);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 409);
		}
	});

	app.get("/projects", (c) => {
		return c.json(ctx.pm.list());
	});

	app.get("/projects/:id", (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json(project);
	});

	app.delete("/projects/:id", async (c) => {
		const projectId = c.req.param("id");
		await stopAgent(ctx, projectId);
		try {
			await ctx.pm.delete(projectId);

			// Clean up orphaned files on disk
			try {
				await rm(join(ctx.config.dataDir, "events", `${projectId}.json`), {
					force: true,
				});
				await rm(join(ctx.config.dataDir, "sessions", projectId), {
					recursive: true,
					force: true,
				});
				await rm(join(ctx.config.dataDir, "projects", projectId), {
					recursive: true,
					force: true,
				});
			} catch {
				// Files may not exist — ignore cleanup errors
			}

			// Clean up all in-memory state for this project
			ctx.trackers.delete(projectId);
			ctx.pendingClarifications.delete(projectId);
			ctx.eventHistory.delete(projectId);
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 404);
		}
	});

	// Event history
	app.get("/projects/:id/events", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const events = ctx.eventHistory.has(project.id)
			? (ctx.eventHistory.get(project.id) as Record<string, unknown>[])
			: await loadEventHistory(ctx, project.id);
		return c.json({ events });
	});

	// Pending messages — derived from queue state
	app.get("/projects/:id/pending-messages", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		// Check the root orchestrator's queue for pending user messages
		const tracker = ctx.trackers.get(project.id);
		const rootNodeId = tracker?.rootNodeId;
		let pending: { text: string; timestamp: number }[] = [];
		if (rootNodeId) {
			const queue =
				globalAgentQueues.get(rootNodeId) ??
				ctx.activeSessions.get(project.id)?.queue;
			if (queue) {
				pending = queue
					.peekMessages()
					.filter((m) => m.source === "user")
					.map((m) => ({
						text: (m as { content: string }).content,
						timestamp: Date.now(),
					}));
			}
		}
		return c.json({ messages: pending });
	});

	// Pending clarifications
	app.get("/projects/:id/clarifications", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({
			clarifications: getPendingClarifications(ctx, project.id),
		});
	});
}
