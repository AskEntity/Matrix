import type { Hono } from "hono";
import {
	loadProjectLocalConfig,
	loadProjectRepoConfig,
	type OpenGraftConfig,
	resolveConfig,
	saveGlobalConfig,
	saveProjectLocalConfig,
	saveProjectRepoConfig,
} from "../../config.ts";
import type { DaemonContext } from "../context.ts";

export function registerConfigRoutes(app: Hono, ctx: DaemonContext) {
	// Global config
	app.get("/config/global", async (c) => {
		return c.json(ctx.globalConfig);
	});

	app.patch("/config/global", async (c) => {
		const partial = (await c.req.json()) as Partial<OpenGraftConfig>;
		// Merge scalar fields, union map fields
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (ctx.globalConfig as Record<string, unknown>)[k];
			} else {
				(ctx.globalConfig as Record<string, unknown>)[k] = v;
			}
		}
		await saveGlobalConfig(ctx.globalConfig, ctx.config.globalConfigPath);
		return c.json(ctx.globalConfig);
	});

	// Project repo config (stored in <project>/.opengraft/config.json)
	app.get("/projects/:id/config/repo", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const cfg = await loadProjectRepoConfig(project.path);
		return c.json(cfg);
	});

	app.patch("/projects/:id/config/repo", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const partial = (await c.req.json()) as Partial<OpenGraftConfig>;
		const existing = await loadProjectRepoConfig(project.path);
		const merged = { ...existing };
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (merged as Record<string, unknown>)[k];
			} else {
				(merged as Record<string, unknown>)[k] = v;
			}
		}
		await saveProjectRepoConfig(project.path, merged);
		return c.json(merged);
	});

	// All three config layers + resolved for a project
	app.get("/projects/:id/config/all", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const [repoConfig, localConfig] = await Promise.all([
			loadProjectRepoConfig(project.path),
			loadProjectLocalConfig(ctx.config.dataDir, project.id),
		]);
		const resolved = resolveConfig(ctx.globalConfig, repoConfig, localConfig);
		return c.json({
			global: ctx.globalConfig,
			repo: repoConfig,
			local: localConfig,
			resolved,
		});
	});

	// Project local config (stored in dataDir/projects/<id>/config.json)
	app.get("/projects/:id/config", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const cfg = await loadProjectLocalConfig(ctx.config.dataDir, project.id);
		return c.json(cfg);
	});

	app.patch("/projects/:id/config", async (c) => {
		const project = ctx.pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const partial = (await c.req.json()) as Partial<OpenGraftConfig>;
		const existing = await loadProjectLocalConfig(
			ctx.config.dataDir,
			project.id,
		);
		const merged = { ...existing };
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (merged as Record<string, unknown>)[k];
			} else {
				(merged as Record<string, unknown>)[k] = v;
			}
		}
		await saveProjectLocalConfig(ctx.config.dataDir, project.id, merged);
		return c.json(merged);
	});
}
