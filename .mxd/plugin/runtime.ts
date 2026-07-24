/**
 * Matrix plugin runtime — builds ScopeOpts + registers plugin-specific HTTP routes.
 *
 * Generic interface: (projectId, ctx) → ScopeOpts for buildScopeOpts.
 * registerRoutes(app, ctx) mounts matrix's own endpoints + production-mode guard.
 * Matrix-specific args (selfBootstrap) read from ctx.globalConfig.
 */
import type { Hono } from "hono";
import type { RuntimeContext } from "../../src/runtime/context.ts";
import { isTask } from "../../src/types.ts";
import { isProductionProject } from "./production.ts";
import { registerMockShowcaseRoute } from "./routes/mock-showcase.ts";
import { buildMatrixScopeOpts } from "./scope-opts.ts";

export function buildScopeOpts(projectId: string, ctx: RuntimeContext) {
	return buildMatrixScopeOpts(
		projectId,
		ctx.globalConfig.selfBootstrap ?? false,
		ctx,
	);
}

/**
 * Register matrix-specific HTTP routes + middleware.
 *
 * Only backend guard lives here — the UI computes production-mode locally
 * (globalContext + project.path → same pure function). Client doesn't need
 * a server round-trip just to branch on a derivable state.
 *
 * Guard: block non-GET requests on `/projects/:id/*` when the project is in
 * production mode. External clients (tests, CLI, other daemons) still need
 * this enforcement; it can't be a UI-only check.
 */
export function registerRoutes(app: Hono, ctx: RuntimeContext) {
	app.use("/projects/:id/*", async (c, next) => {
		if (c.req.method === "GET") return next();
		const projectId = c.req.param("id");
		if (!projectId) return next();
		const project = ctx.pm.get(projectId);
		if (!project || !ctx.globalContext) return next();
		if (isProductionProject(project.path, ctx.globalContext)) {
			return c.json(
				{
					error: "Project is in production mode. No agent operations allowed.",
				},
				403,
			);
		}
		return next();
	});

	// Mock showcase — static data endpoint for UI development/testing.
	// Previously registered unconditionally in runtime.ts for every plugin
	// worker. Now matrix-specific: only the matrix worker serves it.
	registerMockShowcaseRoute(app);

	// ── Search endpoint ──
	// Sidebar search: keyword + hybrid (Orama BM25 + vector when available).
	// Lives here (matrix plugin route) because the index is matrix-specific
	// (reads resultRounds, lives in matrix's dataRoot).
	app.get("/projects/:id/search", async (c) => {
		const projectId = c.req.param("id");
		const query = c.req.query("q") ?? "";
		const limitStr = c.req.query("limit");
		const limit = limitStr
			? Math.min(Math.max(Number(limitStr) || 20, 1), 50)
			: 20;

		if (!query.trim()) {
			return c.json([]);
		}

		try {
			const { projectIndexDbPath } = await import("../../src/data-paths.ts");
			const { searchIndex } = await import("../../src/task-index.ts");
			const dbPath = projectIndexDbPath(
				ctx.config.dataDir,
				projectId,
				ctx.config.dataRoot,
			);
			const hits = await searchIndex(dbPath, query, limit);

			// Enrich with current task titles from the tracker.
			// Use ctx.trackers directly (already loaded at startup) — avoids
			// pulling in the full getTracker which has scope-opts dependencies.
			const tracker = ctx.trackers.get(projectId);
			if (!tracker) return c.json([]);
			// flatMap (not map + filter(Boolean)) so the "deleted since indexing"
			// drop narrows the element type — filter(Boolean) leaves `| null` in.
			const enriched = hits.flatMap((hit) => {
				const task = tracker.getTask(hit.taskId);
				if (!task) return []; // Deleted since indexing
				return [{ ...hit, title: task.title }];
			});

			// Deduplicate by taskId — same task may hit on title + description +
			// result rounds. Keep only the highest-scoring hit per task.
			const seen = new Map<string, (typeof enriched)[number]>();
			for (const hit of enriched) {
				const prev = seen.get(hit.taskId);
				if (!prev || hit.score > prev.score) {
					seen.set(hit.taskId, hit);
				}
			}
			const deduped = [...seen.values()];

			return c.json(deduped);
		} catch (e) {
			console.warn(`[search] failed for ${projectId}:`, e);
			return c.json([]);
		}
	});

	// ── Edit endpoint ──
	// Edit a user message: roll back to just before it, then send new content.
	// Combines rollback + message delivery in one atomic operation.
	app.post("/projects/:id/tasks/:nodeId/edit", async (c) => {
		const projectId = c.req.param("id");
		const nodeId = c.req.param("nodeId");
		const body = await c.req
			.json<{
				eid: string;
				content: string;
				images?: Array<{ base64: string; mediaType: string }>;
			}>()
			.catch(() => null);

		if (
			!body?.eid ||
			(!body?.content?.trim() && (!body?.images || body.images.length === 0))
		) {
			return c.json({ error: "eid and content or images required" }, 400);
		}

		const project = ctx.pm.get(projectId);
		if (!project) return c.json({ error: "Project not found" }, 404);

		const tracker = ctx.trackers.get(projectId);
		if (!tracker) return c.json({ error: "Tracker not found" }, 404);

		const node = tracker.getTask(nodeId);
		if (!node || !isTask(node)) {
			return c.json({ error: "Task not found" }, 404);
		}

		const { getEventStore } = await import("../../src/runtime/helpers.ts");
		const eventStore = getEventStore(ctx, projectId);
		if (!eventStore.has(nodeId)) {
			return c.json({ error: "No session data" }, 400);
		}

		// Read all events and validate the target
		const allEvents = eventStore.read(nodeId);
		const targetEvent = allEvents.find((e) => e.eid === body.eid);
		if (!targetEvent) {
			return c.json({ error: "eid not found" }, 400);
		}
		// Must be a user message
		if (targetEvent.type !== "message" || targetEvent.body?.source !== "user") {
			return c.json({ error: "eid must point to a user message" }, 400);
		}
		// Must be after the last compact_marker
		const lastCompactIdx = allEvents.findLastIndex(
			(e) => e.type === "compact_marker",
		);
		const targetIdx = allEvents.indexOf(targetEvent);
		if (lastCompactIdx >= 0 && targetIdx <= lastCompactIdx) {
			return c.json(
				{ error: "Cannot edit a message before compact boundary" },
				400,
			);
		}
		// The edited message's parentEid is the rollback target — the chain
		// will include everything up to (and including) that event, effectively
		// removing the edited message and everything after it.
		const rollbackTargetEid = targetEvent.parentEid;
		if (rollbackTargetEid == null) {
			return c.json(
				{ error: "Cannot edit the first event in the session" },
				400,
			);
		}

		// Stop the running agent (if any) and wait for loop exit
		const { stopTask } = await import("../../src/runtime/agent-lifecycle.ts");
		if (node.session) {
			await stopTask(ctx, projectId, nodeId);
		} else {
			const loopPromise = ctx.agentLoopPromises.get(nodeId);
			if (loopPromise) await loopPromise;
		}

		// Flush pending writes so lastEventIds is current
		await eventStore.flushSession(nodeId);

		// Set chain head to the target — next appended event's parentEid
		// will jump to rollbackTargetEid, skipping rolled-back events
		eventStore.setChainHead(nodeId, rollbackTargetEid);

		// Send the edited content as a new user message
		const { deliverMessage } = await import(
			"../../src/runtime/agent-lifecycle.ts"
		);
		const { createUserMessage } = await import(
			"../../src/queue-message-factory.ts"
		);
		const msg = createUserMessage((body.content ?? "").trim(), {
			images: body.images,
		});
		await deliverMessage(ctx, project, nodeId, msg);

		return c.json({ ok: true });
	});
}
