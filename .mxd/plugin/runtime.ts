/**
 * Matrix plugin runtime — builds ScopeOpts + registers plugin-specific HTTP routes.
 *
 * Generic interface: (projectId, ctx) → ScopeOpts for buildScopeOpts.
 * registerRoutes(app, ctx) mounts matrix's own endpoints + production-mode guard.
 * Matrix-specific args (selfBootstrap) read from ctx.globalConfig.
 */
import type { Hono } from "hono";
import { buildMatrixScopeOpts } from "../../src/runtime/agent-lifecycle.ts";
import type { RuntimeContext } from "../../src/runtime/context.ts";
import { isProductionProject } from "./production.ts";

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
}
