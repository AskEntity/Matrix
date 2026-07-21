/**
 * Matrix plugin runtime — builds ScopeOpts + registers plugin-specific HTTP routes.
 *
 * Generic interface: (projectId, ctx) → ScopeOpts for buildScopeOpts.
 * registerRoutes(app, ctx) mounts matrix's own endpoints + production-mode guard.
 * Matrix-specific args (selfBootstrap) read from ctx.globalConfig.
 */
import type { Hono } from "hono";
import type { RuntimeContext } from "../../src/runtime/context.ts";
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
			const enriched = hits
				.map((hit) => {
					const task = tracker.getTask(hit.taskId);
					if (!task) return null; // Deleted since indexing
					return { ...hit, title: task.title };
				})
				.filter(Boolean);

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
}
