import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { stopAgent } from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import { getPendingClarifications } from "../event-system.ts";
import { getEventStore, normalizeEventForUI } from "../helpers.ts";

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
			ctx.eventStores.delete(projectId);
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 404);
		}
	});

	// Event history — merged from all tasks' JSONL EventStores, sorted by ts
	app.get("/projects/:id/events", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const eventStore = getEventStore(ctx, project.id);
		// Read all sessions and normalize for UI consumption
		const all: Record<string, unknown>[] = [];
		for (const sessionId of eventStore.listSessions()) {
			for (const event of eventStore.read(sessionId)) {
				all.push(normalizeEventForUI(event, sessionId));
			}
		}
		all.sort((a, b) => ((a.ts as number) ?? 0) - ((b.ts as number) ?? 0));
		return c.json({ events: all });
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
