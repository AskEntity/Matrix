import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AgentProvider } from "./agent-provider.ts";
import { ClaudeCodeProvider } from "./claude-code-provider.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ProjectManager } from "./project-manager.ts";
import { TaskTracker } from "./task-tracker.ts";
import type { HealthResponse, TaskStatus } from "./types.ts";

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
	const trackers = new Map<string, TaskTracker>();

	/** Get or create a TaskTracker for a project. */
	async function getTracker(projectId: string): Promise<TaskTracker> {
		let tracker = trackers.get(projectId);
		if (!tracker) {
			const treePath = join(config.dataDir, "projects", projectId, "tree.json");
			tracker = new TaskTracker(treePath);
			await tracker.load();
			trackers.set(projectId, tracker);
		}
		return tracker;
	}

	// Health
	app.get("/health", (c) => {
		const response: HealthResponse = {
			status: "ok",
			version: VERSION,
			uptime: Date.now() - startTime,
		};
		return c.json(response);
	});

	// Projects CRUD
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
			trackers.delete(c.req.param("id"));
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 404);
		}
	});

	// Task tree
	app.get("/projects/:id/tasks", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(project.id);
		return c.json({
			root: tracker.getRoot() ?? null,
			nodes: tracker.allNodes(),
		});
	});

	app.post("/projects/:id/tasks", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{
			title: string;
			description: string;
			parentId?: string;
		}>();
		if (!body.title) {
			return c.json({ error: "title is required" }, 400);
		}

		const tracker = await getTracker(project.id);
		try {
			const node = body.parentId
				? tracker.addChild(body.parentId, body.title, body.description ?? "")
				: tracker.createRoot(body.title, body.description ?? "");
			await tracker.save();
			return c.json(node, 201);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 409);
		}
	});

	app.patch("/projects/:id/tasks/:nodeId", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(project.id);
		const nodeId = c.req.param("nodeId");
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}
		const body = await c.req.json<{
			status?: TaskStatus;
			branch?: string;
		}>();
		if (body.status) {
			tracker.updateStatus(nodeId, body.status);
		}
		if (body.branch) {
			tracker.assignBranch(nodeId, body.branch);
		}
		await tracker.save();
		return c.json(tracker.get(nodeId));
	});

	app.delete("/projects/:id/tasks/:nodeId", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(project.id);
		const nodeId = c.req.param("nodeId");
		if (!tracker.get(nodeId)) {
			return c.json({ error: "Task not found" }, 404);
		}
		tracker.remove(nodeId);
		await tracker.save();
		return c.json({ ok: true });
	});

	// Agent execution (one-shot)
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

	// Agent execution (SSE streaming)
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

	// Orchestrator: run pending tasks through the agent
	app.post("/projects/:id/orchestrate", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(project.id);
		const orch = new Orchestrator(tracker, config.agentProvider, project.path);

		try {
			const results = await orch.run();
			return c.json({
				completed: results.length,
				results: results.map((r) => ({
					taskId: r.node.id,
					title: r.node.title,
					status: r.node.status,
					success: r.agentResult.success,
					output: r.agentResult.output,
					costUsd: r.agentResult.costUsd,
					turns: r.agentResult.turns,
				})),
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 500);
		}
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
