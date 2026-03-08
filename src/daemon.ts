import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AgentProvider } from "./agent-provider.ts";
import { ClaudeCodeProvider } from "./claude-code-provider.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ProjectManager } from "./project-manager.ts";
import { Runner } from "./runner.ts";
import { TaskTracker } from "./task-tracker.ts";
import type { DecomposedTask, HealthResponse, TaskStatus } from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

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

	/** Read .ai/memory.md from a project directory. Returns empty string if not found. */
	function readProjectMemory(projectPath: string): string {
		try {
			return readFileSync(join(projectPath, ".ai", "memory.md"), "utf-8");
		} catch {
			return "";
		}
	}

	/** Prepend project memory to a prompt if available. */
	function withMemory(projectPath: string, prompt: string): string {
		const memory = readProjectMemory(projectPath);
		if (!memory) return prompt;
		return `## Project Memory\n${memory}\n\n${prompt}`;
	}

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
				prompt: withMemory(project.path, body.prompt),
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
						prompt: withMemory(project.path, body.prompt),
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

	// Task decomposition: agent breaks goal into task tree
	app.post("/projects/:id/decompose", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{ goal: string; maxTurns?: number }>();
		if (!body.goal) {
			return c.json({ error: "goal is required" }, 400);
		}

		const memory = readProjectMemory(project.path);
		const prompt = buildDecomposePrompt(body.goal, memory);

		try {
			const result = await config.agentProvider.execute({
				prompt,
				cwd: project.path,
				systemPrompt: DECOMPOSE_PROMPT,
				maxTurns: body.maxTurns ?? 10,
			});

			if (!result.success) {
				return c.json(
					{ error: "Decomposition failed", output: result.output },
					500,
				);
			}

			// Extract JSON from the agent's output
			const tasks = parseDecomposedTasks(result.output);
			if (!tasks) {
				return c.json(
					{
						error: "Could not parse task tree from agent output",
						output: result.output,
					},
					500,
				);
			}

			// Create the task tree in the tracker
			const tracker = await getTracker(project.id);
			const root = tracker.createRoot(tasks.title, tasks.description);
			if (tasks.children) {
				createChildTasks(tracker, root.id, tasks.children);
			}
			await tracker.save();

			return c.json({
				root: tracker.getRoot(),
				nodes: tracker.allNodes(),
				costUsd: result.costUsd,
				turns: result.turns,
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 500);
		}
	});

	// Runner: worktree-isolated parallel task execution
	app.post("/projects/:id/execute", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const tracker = await getTracker(project.id);
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);
		const runner = new Runner(tracker, config.agentProvider, wm, project.path);

		try {
			const result = await runner.run();
			return c.json({
				...result,
				events: runner.getEvents(),
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 500);
		}
	});

	// Runner SSE: stream execution events in real-time
	app.post("/projects/:id/execute/stream", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}

		const tracker = await getTracker(project.id);
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);

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

				const runner = new Runner(
					tracker,
					config.agentProvider,
					wm,
					project.path,
					{
						onEvent: (evt) => send("event", evt),
					},
				);

				try {
					const result = await runner.run();
					send("result", result);
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

const DECOMPOSE_PROMPT = `You are a task decomposition system. Given a high-level goal, break it into a hierarchical task tree.

## Rules
1. The root task is the overall goal.
2. Each leaf task should be independently executable by a single agent session.
3. Leaf tasks should be concrete and actionable (not abstract).
4. Each task needs a clear title and description.
5. Keep the tree shallow: prefer 2-3 levels max.
6. Order children so dependencies come first.
7. CRITICAL: Sibling tasks will run IN PARALLEL on separate git branches and then be merged.
   - Each sibling MUST work on DIFFERENT files/modules to avoid merge conflicts.
   - Never have two siblings modify the same file.
   - Split by module/feature boundary, not by step (e.g. "auth module" vs "payment module", NOT "write types" vs "write tests").
   - If tasks share a dependency, create that dependency as an earlier sibling or parent task.

## Output Format
Respond with ONLY a JSON object (no markdown fences, no explanation):
{
  "title": "Root task title",
  "description": "What the overall goal is",
  "children": [
    {
      "title": "Subtask 1",
      "description": "Concrete steps for this subtask",
      "children": []
    }
  ]
}`;

function buildDecomposePrompt(goal: string, memory: string): string {
	const parts: string[] = [];
	if (memory) {
		parts.push(`## Project Memory\n${memory}\n`);
	}
	parts.push(`## Goal\n${goal}`);
	return parts.join("\n");
}

function parseDecomposedTasks(output: string): DecomposedTask | null {
	// Try to extract JSON from the output — agent may wrap it in markdown fences
	const jsonMatch =
		output.match(/```(?:json)?\s*([\s\S]*?)```/) ??
		output.match(/(\{[\s\S]*\})/);
	if (!jsonMatch?.[1]) return null;

	try {
		const parsed = JSON.parse(jsonMatch[1].trim()) as DecomposedTask;
		if (!parsed.title) return null;
		return parsed;
	} catch {
		return null;
	}
}

function createChildTasks(
	tracker: TaskTracker,
	parentId: string,
	children: DecomposedTask[],
): void {
	for (const child of children) {
		const node = tracker.addChild(
			parentId,
			child.title,
			child.description ?? "",
		);
		if (child.children && child.children.length > 0) {
			createChildTasks(tracker, node.id, child.children);
		}
	}
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
