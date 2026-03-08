import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { AgentProvider, AgentSession } from "./agent-provider.ts";
import { CostAccumulator, createOrchestratorTools } from "./agent-tools.ts";
import { ClaudeCodeProvider } from "./claude-code-provider.ts";
import { DirectProvider } from "./direct-provider.ts";
import { ProjectManager } from "./project-manager.ts";
import { TaskTracker } from "./task-tracker.ts";
import type {
	DecomposedTask,
	HealthResponse,
	TaskStatus,
	VersionResponse,
} from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

// Read version from package.json at startup.
const _pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const VERSION = _pkg.version;

// Capture git commit hash at startup (empty string if not in a git repo).
const _commitProc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
	stdout: "pipe",
	stderr: "pipe",
});
const GIT_COMMIT =
	_commitProc.exitCode === 0 ? _commitProc.stdout.toString().trim() : "unknown";

/** WebSocket client connection with project subscription. */
interface WSClient {
	ws: WSContext;
	projectId: string | null;
}

/** Broadcast an event to all WebSocket clients subscribed to a project. */
function broadcast(
	clients: Set<WSClient>,
	projectId: string,
	event: Record<string, unknown>,
) {
	const msg = JSON.stringify(event);
	for (const client of clients) {
		if (client.projectId === projectId) {
			try {
				client.ws.send(msg);
			} catch {
				/* client disconnected */
			}
		}
	}
}
const startTime = Date.now();
const START_AT = new Date(startTime).toISOString();

export interface DaemonConfig {
	dataDir: string;
	agentProvider: AgentProvider;
}

function defaultProvider(): AgentProvider {
	const provider = process.env.OG_PROVIDER ?? "claude-code";
	if (provider === "direct") {
		return new DirectProvider(process.env.OG_MODEL);
	}
	return new ClaudeCodeProvider();
}

const defaultConfig: DaemonConfig = {
	dataDir: join(homedir(), ".opengraft"),
	agentProvider: defaultProvider(),
};

export function createApp(config: DaemonConfig = defaultConfig) {
	const app = new Hono();
	const pm = new ProjectManager(config.dataDir);
	const trackers = new Map<string, TaskTracker>();
	const activeOrchestrations = new Set<string>();
	const wsClients = new Set<WSClient>();
	/** Active agent sessions by project ID, for message injection. */
	const activeSessions = new Map<string, AgentSession>();

	/** Broadcast a tree update to all subscribers of a project. */
	function broadcastTreeUpdate(projectId: string, tracker: TaskTracker) {
		broadcast(wsClients, projectId, {
			type: "tree_updated",
			nodes: tracker.allNodes(),
		});
	}

	/** Broadcast an agent event to subscribers. */
	function broadcastEvent(projectId: string, event: Record<string, unknown>) {
		broadcast(wsClients, projectId, event);
	}

	/** Read .opengraft/memory.md from a project directory. Returns empty string if not found. */
	function readProjectMemory(projectPath: string): string {
		const parts: string[] = [];

		// Read CLAUDE.md for project architecture context
		try {
			const claudeMd = readFileSync(join(projectPath, "CLAUDE.md"), "utf-8");
			if (claudeMd) parts.push(`## CLAUDE.md\n${claudeMd}`);
		} catch {
			// No CLAUDE.md, that's fine
		}

		// Read .opengraft/memory.md for agent-specific memory
		try {
			const memory = readFileSync(
				join(projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
			if (memory) parts.push(`## Agent Memory\n${memory}`);
		} catch {
			// No memory file, that's fine
		}

		return parts.join("\n\n");
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

	// Version
	app.get("/version", (c) => {
		const response: VersionResponse = {
			version: VERSION,
			commit: GIT_COMMIT,
			startedAt: START_AT,
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

	app.post("/projects/:id/tasks/:nodeId/continue", async (c) => {
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
		if (node.status !== "failed" && node.status !== "stuck") {
			return c.json(
				{ error: `Cannot continue task with status: ${node.status}` },
				400,
			);
		}
		const body = await c.req
			.json<{ message?: string }>()
			.catch(() => ({ message: undefined }));
		if (body.message) {
			tracker.setMessage(nodeId, body.message);
		}
		tracker.updateStatus(nodeId, "pending");
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
		const body = await c.req.json<{
			prompt: string;
			maxTurns?: number;
			model?: string;
		}>();
		if (!body.prompt) {
			return c.json({ error: "prompt is required" }, 400);
		}
		try {
			const result = await config.agentProvider.execute({
				prompt: withMemory(project.path, body.prompt),
				cwd: project.path,
				maxTurns: body.maxTurns,
				model: body.model,
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
		const body = await c.req.json<{
			prompt: string;
			maxTurns?: number;
			model?: string;
		}>();
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
						model: body.model,
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

	// Agent-driven orchestration: main agent gets MCP tools to observe/manipulate task tree
	app.post("/projects/:id/orchestrate/agent", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{
			prompt: string;
			maxTurns?: number;
			resume?: boolean;
			model?: string;
			childModel?: string;
		}>();
		if (!body.prompt && !body.resume) {
			return c.json({ error: "prompt is required" }, 400);
		}

		if (activeOrchestrations.has(project.id)) {
			return c.json(
				{ error: "Orchestration already running for this project" },
				409,
			);
		}

		activeOrchestrations.add(project.id);
		const tracker = await getTracker(project.id);
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);

		const costAccumulator = new CostAccumulator();
		const { mcpServer, toolDefs } = createOrchestratorTools(
			{
				tracker,
				provider: config.agentProvider,
				worktrees: wm,
				projectPath: project.path,
				childModel: body.childModel,
				onTaskEvent: (event) => {
					broadcastEvent(project.id, event);
					broadcastTreeUpdate(project.id, tracker);
				},
			},
			costAccumulator,
		);

		const memory = readProjectMemory(project.path);
		const prompt = body.resume
			? (body.prompt ??
				"Continue where you left off. Check the task tree and proceed.")
			: memory
				? `## Project Memory\n${memory}\n\n${body.prompt}`
				: body.prompt;

		const resumeSessionId = body.resume
			? (tracker.orchestratorSessionId ?? undefined)
			: undefined;

		try {
			const result = await config.agentProvider.execute({
				prompt,
				cwd: project.path,
				systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
				maxTurns: body.maxTurns ?? 50,
				mcpServers: { opengraft: mcpServer },
				mcpToolDefs: { opengraft: toolDefs },
				resumeSessionId,
				model: body.model,
			});

			// Persist orchestrator session ID for future resume
			if (result.sessionId) {
				tracker.orchestratorSessionId = result.sessionId;
				await tracker.save();
			}

			// Combine orchestrator cost with child agent costs
			const totalCostUsd = (result.costUsd ?? 0) + costAccumulator.totalCostUsd;

			return c.json({
				...result,
				costUsd: totalCostUsd,
				childCosts: {
					totalCostUsd: costAccumulator.totalCostUsd,
					totalTurns: costAccumulator.totalTurns,
					taskCount: costAccumulator.taskCount,
				},
				tree: {
					root: tracker.getRoot() ?? null,
					nodes: tracker.allNodes(),
				},
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 500);
		} finally {
			activeOrchestrations.delete(project.id);
		}
	});

	// Inject a message into a running orchestration
	app.post("/projects/:id/message", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{ message: string }>();
		if (!body.message) {
			return c.json({ error: "message is required" }, 400);
		}

		const session = activeSessions.get(project.id);
		if (!session) {
			return c.json({ error: "No active session for this project" }, 404);
		}

		await session.sendMessage(body.message);
		return c.json({ ok: true, sessionId: session.sessionId });
	});

	// WebSocket endpoint for real-time updates
	app.get(
		"/ws",
		upgradeWebSocket((_c) => {
			const client: WSClient = {
				ws: null as unknown as WSContext,
				projectId: null,
			};

			return {
				onOpen(_evt, ws) {
					client.ws = ws;
					wsClients.add(client);
				},
				onMessage(evt, ws) {
					try {
						const msg = JSON.parse(
							typeof evt.data === "string" ? evt.data : "",
						) as {
							type: string;
							projectId?: string;
							prompt?: string;
							maxTurns?: number;
							model?: string;
							childModel?: string;
						};

						if (msg.type === "subscribe" && msg.projectId) {
							client.projectId = msg.projectId;
							// Send current tree immediately
							const tracker = trackers.get(msg.projectId);
							if (tracker) {
								ws.send(
									JSON.stringify({
										type: "tree_updated",
										nodes: tracker.allNodes(),
									}),
								);
							}
						}

						if (msg.type === "orchestrate" && msg.projectId && msg.prompt) {
							// Trigger orchestration asynchronously
							runOrchestrateViaWS(
								msg.projectId,
								msg.prompt,
								msg.maxTurns ?? 50,
								msg.model,
								msg.childModel,
							);
						}

						if (msg.type === "inject_message" && msg.projectId && msg.prompt) {
							const session = activeSessions.get(msg.projectId);
							if (session) {
								session.sendMessage(msg.prompt);
								broadcastEvent(msg.projectId, {
									type: "message_injected",
									message: msg.prompt,
								});
							} else {
								ws.send(
									JSON.stringify({
										type: "error",
										message: "No active session for this project",
									}),
								);
							}
						}
					} catch {
						/* ignore parse errors */
					}
				},
				onClose() {
					wsClients.delete(client);
				},
			};
		}),
	);

	/** Run orchestration triggered via WebSocket, broadcasting events. */
	async function runOrchestrateViaWS(
		projectId: string,
		prompt: string,
		maxTurns: number,
		model?: string,
		childModel?: string,
	) {
		const project = pm.get(projectId);
		if (!project) return;

		if (activeOrchestrations.has(projectId)) {
			broadcastEvent(projectId, {
				type: "error",
				message: "Orchestration already running",
			});
			return;
		}

		activeOrchestrations.add(projectId);
		broadcastEvent(projectId, { type: "orchestration_started" });

		const tracker = await getTracker(projectId);
		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);

		const costAccumulator = new CostAccumulator();

		// Wrap the orchestrator tools to broadcast events on state changes
		const { mcpServer, toolDefs } = createOrchestratorTools(
			{
				tracker,
				provider: config.agentProvider,
				worktrees: wm,
				projectPath: project.path,
				childModel,
				onTaskEvent: (event) => {
					broadcastEvent(projectId, event);
					// Also broadcast tree update after any task event
					broadcastTreeUpdate(projectId, tracker);
				},
			},
			costAccumulator,
		);

		const memory = readProjectMemory(project.path);
		const fullPrompt = memory
			? `## Project Memory\n${memory}\n\n${prompt}`
			: prompt;

		try {
			// Use interactive session for message injection support
			const session = config.agentProvider.startSession({
				prompt: fullPrompt,
				cwd: project.path,
				systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
				maxTurns,
				mcpServers: { opengraft: mcpServer },
				mcpToolDefs: { opengraft: toolDefs },
				model,
			});

			// Track the session for message injection
			activeSessions.set(projectId, session);

			let finalResult: {
				success: boolean;
				output: string;
				sessionId?: string;
				costUsd?: number;
			} = {
				success: false,
				output: "",
			};
			let result = await session.events.next();
			while (!result.done) {
				// Forward agent events to WS clients
				const agentEvent = result.value;
				const { type: eventType, ...eventData } = agentEvent;
				broadcastEvent(projectId, {
					type: "agent_event",
					eventType,
					...eventData,
				});
				result = await session.events.next();
			}
			finalResult = result.value;

			if (finalResult.sessionId) {
				tracker.orchestratorSessionId = finalResult.sessionId;
				await tracker.save();
			}

			const totalCostUsd =
				(finalResult.costUsd ?? 0) + costAccumulator.totalCostUsd;

			broadcastEvent(projectId, {
				type: "orchestration_completed",
				success: finalResult.success,
				costUsd: totalCostUsd,
				childCosts: {
					totalCostUsd: costAccumulator.totalCostUsd,
					totalTurns: costAccumulator.totalTurns,
					taskCount: costAccumulator.taskCount,
				},
			});
			broadcastTreeUpdate(projectId, tracker);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			broadcastEvent(projectId, {
				type: "error",
				message,
			});
		} finally {
			const session = activeSessions.get(projectId);
			if (session) session.stop();
			activeSessions.delete(projectId);
			activeOrchestrations.delete(projectId);
		}
	}

	// Static file serving for the web UI
	app.get("/", (c) => c.redirect("/web/index.html"));
	app.use("/web/*", serveStatic({ root: "./" }));

	return { app, pm, wsClients };
}

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the OpenGraft orchestrator agent. You break goals into tasks and execute them.

## Available Tools (via MCP server "opengraft")
- get_tree: View the current task tree
- create_task: Add tasks to the tree (root or children)
- update_task_status: Update a task's status
- spawn_task: Execute a single task on an isolated git worktree (blocks until done). Accepts optional maxTurns.
- spawn_children: Execute ALL pending children of a parent in PARALLEL (recommended). Accepts optional maxTurns.
- continue_task: Resume a failed/stuck task with optional instructions. Use when a task hit max turns or failed.
- delete_task: Clean up a child's worktree + branch + task node (call AFTER you merge)

## Workflow
1. Analyze the goal and the codebase
2. Create a root task, then decompose into child tasks using create_task
3. CRITICAL: Sibling tasks run in PARALLEL — each must work on DIFFERENT files/modules
4. Call spawn_children(parentId) to execute all children in parallel
5. When a child passes, YOU merge its branch yourself:
   a. Check the child's work (review files on the branch)
   b. Merge via bash: git merge --no-ff <child-branch> -m "Merge task: <title>"
      (run this from the parent's worktree directory, or the main repo if no parent worktree)
   c. Call delete_task(taskId) to clean up the child's worktree, branch, and task node
6. After all children are merged, mark the root task as "passed"

## Task Lifecycle
pending → in_progress (agent working) → passed/failed/stuck
After a child passes: parent reviews → parent merges branch → parent calls delete_task
If a child fails or gets stuck: use continue_task to resume with additional instructions

## Merge Details
- You have bash access. Use \`git merge --no-ff <branch> -m "..."\` to merge.
- Merge from the directory that has the target branch checked out.
- If merge conflicts occur, resolve them or mark the child as "stuck".
- After successful merge, call delete_task to clean up.

## Rules
- Split by module/feature boundary, NOT by step (e.g. "auth module" vs "payment module")
- Never have two siblings modify the same file
- Keep the tree shallow: 2-3 levels max
- Each leaf task should be independently executable by a single agent session
- Use spawn_children for parallel execution — calling spawn_task multiple times runs sequentially
- ALWAYS merge and delete_task each passed child before moving on
- ALWAYS mark the root task as "passed" when everything succeeds, or "failed" if something went wrong`;

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
	console.log(`Web UI: http://localhost:${port}/`);
	console.log(`Provider: ${defaultConfig.agentProvider.name}`);
	Bun.serve({
		fetch: app.fetch,
		port,
		websocket,
	});
}
