import type { Hono } from "hono";
import type { RuntimeContext } from "../context.ts";
import { getPendingClarifications } from "../event-system.ts";
import { getEventStore } from "../helpers.ts";

/**
 * Project data routes — event history, clarifications.
 * Project CRUD (list, create, delete, update) is handled by the daemon shell.
 * These routes provide data that lives in the worker (JSONL events, streaming text).
 */
export function registerProjectRoutes(app: Hono, ctx: RuntimeContext) {
	// Event history — merged from all tasks' JSONL EventStores, sorted by ts
	app.get("/projects/:id/events", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const eventStore = getEventStore(ctx, project.id);
		const afterCompact = c.req.query("after") === "compact";

		const all: Record<string, unknown>[] = [];
		let hasOlderEvents = false;

		for (const sessionId of eventStore.listSessions()) {
			if (afterCompact) {
				const result = eventStore.readFromLastCompactMarker(sessionId);
				if (result.hasOlderEvents) hasOlderEvents = true;
				for (const event of result.events) {
					all.push(event as unknown as Record<string, unknown>);
				}
			} else {
				for (const event of eventStore.read(sessionId)) {
					all.push(event as unknown as Record<string, unknown>);
				}
			}
		}
		// Inject partial streaming thinking + text for any actively streaming
		// sessions. These events carry `partial: true` so clients treat them as
		// monotonic extends against the live text_delta / thinking_delta stream,
		// not authoritative replacements — see extend_text / extend_thinking in
		// the plugin event-handler.
		const partialTs = Date.now();
		for (const [nodeId, partialThinking] of ctx.streamingThinking) {
			if (partialThinking) {
				all.push({
					type: "thinking",
					thinking: partialThinking,
					signature: "",
					taskId: nodeId,
					ts: partialTs,
					partial: true,
				});
			}
		}
		for (const [nodeId, partialText] of ctx.streamingText) {
			if (partialText) {
				all.push({
					type: "assistant_text",
					content: partialText,
					taskId: nodeId,
					ts: partialTs,
					partial: true,
				});
			}
		}
		all.sort((a, b) => ((a.ts as number) ?? 0) - ((b.ts as number) ?? 0));
		return c.json({ events: all, hasOlderEvents });
	});

	// Fetch older events before a timestamp for a specific session (pagination)
	app.get("/projects/:id/events/older", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const session = c.req.query("session");
		const beforeStr = c.req.query("before");
		const limitStr = c.req.query("limit");
		if (!session || !beforeStr) {
			return c.json(
				{ error: "session and before query params are required" },
				400,
			);
		}
		const before = Number(beforeStr);
		const limit = limitStr ? Number(limitStr) : 200;
		if (Number.isNaN(before) || Number.isNaN(limit)) {
			return c.json({ error: "before and limit must be numbers" }, 400);
		}
		const eventStore = getEventStore(ctx, project.id);
		const result = eventStore.readBefore(session, before, limit);
		return c.json({ events: result.events, hasMore: result.hasMore });
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
