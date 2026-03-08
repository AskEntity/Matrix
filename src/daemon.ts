import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AgentProvider } from "./agent-provider.ts";
import { ClaudeCodeProvider } from "./claude-code-provider.ts";
import { ProjectManager } from "./project-manager.ts";
import type { HealthResponse } from "./types.ts";

const VERSION = "0.0.1";
const startTime = Date.now();

export interface DaemonConfig {
	dataDir: string;
	agentProvider: AgentProvider;
}

const defaultConfig: DaemonConfig = {
	dataDir: join(homedir(), ".opengraft"),
	agentProvider: new ClaudeCodeProvider(),
};

export function createApp(config: DaemonConfig = defaultConfig) {
	const app = new Hono();
	const pm = new ProjectManager(config.dataDir);

	// Health
	app.get("/health", (c) => {
		const response: HealthResponse = {
			status: "ok",
			version: VERSION,
			uptime: Date.now() - startTime,
		};
		return c.json(response);
	});

	// Projects
	app.post("/projects", async (c) => {
		const body = await c.req.json<{ path: string }>();
		if (!body.path) {
			return c.json({ error: "path is required" }, 400);
		}
		try {
			const project = await pm.init(body.path);
			return c.json(project, 201);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 409);
		}
	});

	app.get("/projects", (c) => {
		return c.json(pm.list());
	});

	app.get("/projects/:id", (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json(project);
	});

	app.delete("/projects/:id", async (c) => {
		try {
			await pm.delete(c.req.param("id"));
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 404);
		}
	});

	// Execute agent task (one-shot)
	app.post("/projects/:id/run", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{ prompt: string; maxTurns?: number }>();
		if (!body.prompt) {
			return c.json({ error: "prompt is required" }, 400);
		}
		try {
			const result = await config.agentProvider.execute({
				prompt: body.prompt,
				cwd: project.path,
				maxTurns: body.maxTurns,
			});
			return c.json(result);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 500);
		}
	});

	// Execute agent task (SSE streaming)
	app.post("/projects/:id/stream", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{ prompt: string; maxTurns?: number }>();
		if (!body.prompt) {
			return c.json({ error: "prompt is required" }, 400);
		}

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const send = (event: string, data: unknown) => {
					controller.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
						),
					);
				};

				try {
					const gen = config.agentProvider.stream({
						prompt: body.prompt,
						cwd: project.path,
						maxTurns: body.maxTurns,
					});

					let result = await gen.next();
					while (!result.done) {
						send("event", result.value);
						result = await gen.next();
					}
					// Generator return value is the final result
					send("result", result.value);
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					send("error", { error: message });
				} finally {
					controller.close();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	});

	return { app, pm };
}

// Only start the server when run directly, not when imported for testing.
if (import.meta.main) {
	const port = Number(process.env.PORT) || 7433;
	const { app, pm } = createApp();
	await pm.load();
	console.log(`OpenGraft daemon listening on http://localhost:${port}`);
	Bun.serve({
		fetch: app.fetch,
		port,
	});
}
