import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { AgentProvider, AgentSession } from "./agent-provider.ts";
import {
	CostAccumulator,
	createOrchestratorTools,
	ORCHESTRATION_KNOWLEDGE,
	TASK_SYSTEM_PROMPT,
} from "./agent-tools.ts";
import { ClaudeCodeProvider } from "./claude-code-provider.ts";
import { DirectProvider } from "./direct-provider.ts";
import { MessageQueue } from "./message-queue.ts";
import { ProjectManager } from "./project-manager.ts";
import { TaskTracker } from "./task-tracker.ts";
import type {
	HealthResponse,
	StatsResponse,
	TaskNode,
	TaskStatus,
	VersionResponse,
} from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

// Read version from package.json at startup.
const _pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const VERSION = _pkg.version;

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
				clients.delete(client);
			}
		}
	}
}
const startTime = Date.now();

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

/** Collect a node and all its descendants. */
function collectDescendants(tracker: TaskTracker, nodeId: string): TaskNode[] {
	const node = tracker.get(nodeId);
	if (!node) return [];
	const result: TaskNode[] = [node];
	for (const childId of node.children) {
		result.push(...collectDescendants(tracker, childId));
	}
	return result;
}

const defaultConfig: DaemonConfig = {
	dataDir: join(homedir(), ".opengraft"),
	agentProvider: defaultProvider(),
};

export function createApp(config: DaemonConfig = defaultConfig) {
	const app = new Hono();
	let requestCount = 0;
	app.use("*", async (_c, next) => {
		requestCount++;
		await next();
	});
	const pm = new ProjectManager(config.dataDir);
	const trackers = new Map<string, TaskTracker>();
	const activeOrchestrations = new Set<string>();
	const wsClients = new Set<WSClient>();
	/** Active agent sessions by project ID, for message injection. */
	const activeSessions = new Map<string, AgentSession>();
	/** Event history per project (capped at 500 entries). */
	const eventHistory = new Map<string, Record<string, unknown>[]>();
	const MAX_EVENT_HISTORY = 500;

	function getEventHistory(projectId: string): Record<string, unknown>[] {
		if (!eventHistory.has(projectId)) eventHistory.set(projectId, []);
		return eventHistory.get(projectId) as Record<string, unknown>[];
	}

	/** Broadcast a tree update to all subscribers of a project. */
	function broadcastTreeUpdate(projectId: string, tracker: TaskTracker) {
		broadcast(wsClients, projectId, {
			type: "tree_updated",
			nodes: tracker.allNodes(),
		});
	}

	/** Broadcast an agent event to subscribers and store in history. */
	function broadcastEvent(projectId: string, event: Record<string, unknown>) {
		// Store in history (skip tree_updated — sent on WS connect separately)
		if (event.type !== "tree_updated") {
			const history = getEventHistory(projectId);
			history.push({ ...event, timestamp: Date.now() });
			if (history.length > MAX_EVENT_HISTORY) {
				history.splice(0, history.length - MAX_EVENT_HISTORY);
			}
		}
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
	app.get("/health", async (c) => {
		const response: HealthResponse = {
			status: "ok",
			version: VERSION,
			uptime: Date.now() - startTime,
		};

		if (c.req.query("check_model") === "true") {
			const modelName = process.env.OG_MODEL ?? "claude-sonnet-4-6";
			const apiKey = process.env.ANTHROPIC_API_KEY;
			const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
			const useOAuth = Boolean(oauthToken && !apiKey);

			let client: Anthropic;
			if (useOAuth) {
				client = new Anthropic({
					authToken: oauthToken,
					defaultHeaders: {
						"anthropic-beta": "oauth-2025-04-20",
					},
				});
			} else {
				client = new Anthropic();
			}

			const msgParams = {
				model: modelName,
				messages: [{ role: "user" as const, content: "ping" }],
				max_tokens: 10,
			};
			const t0 = Date.now();
			try {
				if (useOAuth) {
					// biome-ignore lint/suspicious/noExplicitAny: beta types are compatible but not identical
					await (client.beta.messages.create as any)(msgParams);
				} else {
					await client.messages.create(msgParams);
				}
				const latencyMs = Date.now() - t0;
				response.model = { status: "ok", model: modelName, latencyMs };
			} catch (err) {
				response.model = {
					status: "error",
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}

		return c.json(response);
	});

	// Version
	app.get("/version", async (c) => {
		const projects = pm.list();
		const projectCount = projects.length;

		let nodeCount = 0;
		for (const project of projects) {
			const tracker = await getTracker(project.id);
			nodeCount += tracker.allNodes().length;
		}

		const response: VersionResponse = {
			version: VERSION,
			nodeCount,
			projectCount,
		};
		return c.json(response);
	});

	// Stats
	app.get("/stats", async (c) => {
		const projects = pm.list();
		const taskCounts = {
			pending: 0,
			in_progress: 0,
			testing: 0,
			passed: 0,
			failed: 0,
			stuck: 0,
		};

		for (const project of projects) {
			const tracker = await getTracker(project.id);
			for (const node of tracker.allNodes()) {
				taskCounts[node.status]++;
			}
		}

		const response: StatsResponse = {
			uptime: Math.floor((Date.now() - startTime) / 1000),
			requestCount,
			projectCount: projects.length,
			taskCounts,
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
				: tracker.addTask(body.title, body.description ?? "");
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
			.json<{ message?: string; model?: string }>()
			.catch(() => ({ message: undefined, model: undefined }));
		if (body.message) {
			tracker.setMessage(nodeId, body.message);
		}

		// If the task has a worktree, re-run the agent immediately
		if (node.worktreePath) {
			tracker.updateStatus(nodeId, "in_progress");
			await tracker.save();

			broadcastEvent(project.id, {
				type: "task_started",
				taskId: nodeId,
				title: node.title,
			});
			broadcastTreeUpdate(project.id, tracker);

			// If we have a session, the agent already has full context in its history.
			// Just send the user's message (or a simple continue instruction).
			// If no session, include full task context since it's a fresh start.
			const branchReminder = node.branch
				? `\n\nReminder: you are on branch \`${node.branch}\`. Do NOT switch branches.`
				: "";
			let continuePrompt: string;
			if (node.sessionId) {
				continuePrompt = body.message
					? `${body.message}${branchReminder}`
					: `Continue working. Pick up where you left off and complete the task.${branchReminder}`;
			} else {
				const memory = readProjectMemory(project.path);
				continuePrompt = body.message
					? `${body.message}\n\n## Task: ${node.title}\n${node.description}\n\n## Project Memory\n${memory}${branchReminder}`
					: `Continue working on this task.\n\n## Task: ${node.title}\n${node.description}\n\n## Project Memory\n${memory}${branchReminder}`;
			}

			// Run async — return immediately so UI updates
			(async () => {
				try {
					const gen = config.agentProvider.stream({
						prompt: continuePrompt,
						cwd: node.worktreePath as string,
						systemPrompt: TASK_SYSTEM_PROMPT,
						resumeSessionId: node.sessionId ?? undefined,
						model: body.model,
					});

					let result = await gen.next();
					while (!result.done) {
						const { type: eventType, ...eventData } = result.value;
						broadcastEvent(project.id, {
							type: "agent_event",
							taskId: nodeId,
							eventType,
							...eventData,
						});
						result = await gen.next();
					}
					const agentResult = result.value;

					if (agentResult.sessionId) {
						tracker.assignSession(nodeId, agentResult.sessionId);
					}
					const newStatus = agentResult.success ? "passed" : "failed";
					tracker.updateStatus(nodeId, newStatus);
					await tracker.save();
					broadcastEvent(project.id, {
						type: "task_completed",
						taskId: nodeId,
						title: node.title,
						success: agentResult.success,
					});
					broadcastTreeUpdate(project.id, tracker);
				} catch (e) {
					tracker.updateStatus(nodeId, "stuck");
					await tracker.save();
					broadcastEvent(project.id, {
						type: "error",
						message: `Continue failed: ${e instanceof Error ? e.message : String(e)}`,
					});
					broadcastTreeUpdate(project.id, tracker);
				}
			})();

			return c.json(tracker.get(nodeId));
		}

		// No worktree — just reset to pending
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
		const node = tracker.get(nodeId);
		if (!node) {
			return c.json({ error: "Task not found" }, 404);
		}

		// Clean up worktrees for this node and all descendants
		const nodesToRemove = collectDescendants(tracker, nodeId);
		for (const n of nodesToRemove) {
			if (n.worktreePath) {
				try {
					const proc = Bun.spawn(
						["git", "worktree", "remove", "--force", n.worktreePath],
						{ cwd: project.path, stdout: "pipe", stderr: "pipe" },
					);
					await proc.exited;
				} catch {
					/* worktree may already be gone */
				}
				if (n.branch) {
					try {
						const proc = Bun.spawn(["git", "branch", "-D", n.branch], {
							cwd: project.path,
							stdout: "pipe",
							stderr: "pipe",
						});
						await proc.exited;
					} catch {
						/* branch may already be gone */
					}
				}
			}
		}

		tracker.remove(nodeId);
		await tracker.save();
		return c.json({ ok: true });
	});

	// Agent execution (fire-and-forget, same as orchestrate)
	app.post("/projects/:id/run", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{
			prompt: string;
			model?: string;
			childModel?: string;
		}>();
		if (!body.prompt) {
			return c.json({ error: "prompt is required" }, 400);
		}
		if (activeOrchestrations.has(project.id)) {
			return c.json({ error: "Agent already running for this project" }, 409);
		}
		await getTracker(project.id);
		launchAgent(project, body);
		return c.json({ status: "running", projectId: project.id });
	});

	/**
	 * Launch an agent for a project. Returns immediately.
	 * The agent runs in the background; observe via WebSocket.
	 * Uses startSession() for message injection support.
	 */
	function launchAgent(
		project: { id: string; path: string },
		opts: {
			prompt: string;
			resume?: boolean;
			model?: string;
			childModel?: string;
		},
	) {
		const tracker = trackers.get(project.id);
		if (!tracker) return;

		activeOrchestrations.add(project.id);
		broadcastEvent(project.id, { type: "orchestration_started" });

		const wtRoot = join(project.path, ".worktrees");
		const wm = new WorktreeManager(project.path, wtRoot);
		const costAccumulator = new CostAccumulator();
		const queue = new MessageQueue();
		const doneRef: {
			done: null | { status: "passed" | "failed"; summary: string };
		} = { done: null };

		const { mcpServer, toolDefs, hasRunningChildren } = createOrchestratorTools(
			{
				tracker,
				provider: config.agentProvider,
				worktrees: wm,
				projectPath: project.path,
				repoPath: project.path,
				depth: 0,
				childModel: opts.childModel,
				queue,
				doneRef,
				onTaskEvent: (event) => {
					broadcastEvent(project.id, event);
					broadcastTreeUpdate(project.id, tracker);
				},
			},
			costAccumulator,
		);

		// Auto-resume: if we have a previous session, always resume it
		const hasSession = Boolean(tracker.orchestratorSessionId);
		const shouldResume = opts.resume || hasSession;

		const memory = readProjectMemory(project.path);
		const prompt = shouldResume
			? (opts.prompt ??
				"Continue where you left off. Check the task tree and proceed.")
			: memory
				? `## Project Memory\n${memory}\n\n${opts.prompt}`
				: opts.prompt;

		const resumeSessionId = shouldResume
			? (tracker.orchestratorSessionId ?? undefined)
			: undefined;

		// Use startSession for message injection support
		const session = config.agentProvider.startSession({
			prompt,
			cwd: project.path,
			systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
			mcpServers: { opengraft: mcpServer },
			mcpToolDefs: { opengraft: toolDefs },
			resumeSessionId,
			model: opts.model,
			queue,
			doneRef,
			hasRunningChildren,
		});

		activeSessions.set(project.id, session);

		// Fire-and-forget: consume events in background
		(async () => {
			try {
				let result = await session.events.next();
				while (!result.done) {
					const { type: eventType, ...eventData } = result.value;
					broadcastEvent(project.id, {
						type: "agent_event",
						eventType,
						...eventData,
					});
					result = await session.events.next();
				}
				const finalResult = result.value;

				if (finalResult.sessionId) {
					tracker.orchestratorSessionId = finalResult.sessionId;
					await tracker.save();
				}

				const totalCostUsd =
					(finalResult.costUsd ?? 0) + costAccumulator.totalCostUsd;
				broadcastEvent(project.id, {
					type: "orchestration_completed",
					success: finalResult.success,
					costUsd: totalCostUsd,
					turns: finalResult.turns,
					childCosts: {
						totalCostUsd: costAccumulator.totalCostUsd,
						totalTurns: costAccumulator.totalTurns,
						taskCount: costAccumulator.taskCount,
					},
				});
				broadcastTreeUpdate(project.id, tracker);
			} catch (e) {
				const message = e instanceof Error ? e.message : "Unknown error";
				broadcastEvent(project.id, {
					type: "error",
					message: `Agent failed: ${message}`,
				});
			} finally {
				// Always preserve the orchestrator session for future resume,
				// regardless of how it exited (success, failure, or crash).
				await tracker.save();
				session.stop();
				activeSessions.delete(project.id);
				activeOrchestrations.delete(project.id);
			}
		})();
	}

	// Agent-driven orchestration: fire-and-forget, observe via WebSocket
	app.post("/projects/:id/orchestrate/agent", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const body = await c.req.json<{
			prompt: string;
			resume?: boolean;
			model?: string;
			childModel?: string;
		}>();
		if (!body.prompt && !body.resume) {
			return c.json({ error: "prompt is required" }, 400);
		}

		if (activeOrchestrations.has(project.id)) {
			return c.json({ error: "Agent already running for this project" }, 409);
		}

		await getTracker(project.id);
		launchAgent(project, body);

		return c.json({ status: "running", projectId: project.id });
	});

	// Start agent by project path (auto-creates project if needed)
	app.post("/agents/start", async (c) => {
		const body = await c.req.json<{
			path: string;
			prompt: string;
			model?: string;
			childModel?: string;
		}>();
		if (!body.path) {
			return c.json({ error: "path is required" }, 400);
		}
		if (!body.prompt) {
			return c.json({ error: "prompt is required" }, 400);
		}

		const project = await pm.ensureProject(body.path);

		if (activeOrchestrations.has(project.id)) {
			return c.json({ error: "Agent already running for this project" }, 409);
		}

		await getTracker(project.id);
		launchAgent(project, body);
		return c.json({ status: "running", projectId: project.id });
	});

	// Check if an agent is running for a project
	app.get("/projects/:id/agent", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const session = activeSessions.get(project.id);
		return c.json({
			running: !!session,
			sessionId: session?.sessionId ?? null,
		});
	});

	// Stop a running agent
	app.post("/projects/:id/stop", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const session = activeSessions.get(project.id);
		if (!session) {
			return c.json({ error: "No active agent for this project" }, 404);
		}
		session.stop();
		activeSessions.delete(project.id);
		activeOrchestrations.delete(project.id);
		broadcastEvent(project.id, { type: "agent_stopped" });
		return c.json({ ok: true });
	});

	// Inject a message into a running agent
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

		try {
			session.queue.enqueue({ source: "user", content: body.message });
		} catch {
			return c.json({ error: "Queue closed" }, 409);
		}
		return c.json({ ok: true, sessionId: session.sessionId });
	});

	// Respond to a pending clarification request
	app.post("/projects/:id/clarify", async (c) => {
		const projectId = c.req.param("id");
		const body = await c.req.json<{ taskId: string; answer: string }>();
		if (!body.taskId || !body.answer) {
			return c.json({ error: "taskId and answer are required" }, 400);
		}

		const session = activeSessions.get(projectId);
		if (!session) {
			return c.json({ error: "No active session for this project" }, 404);
		}

		try {
			session.queue.enqueue({
				source: "clarify_response",
				answer: body.answer,
			});
		} catch {
			return c.json({ error: "Queue closed" }, 409);
		}
		broadcastEvent(projectId, {
			type: "clarification_answered",
			taskId: body.taskId,
			answer: body.answer,
		});
		return c.json({ ok: true });
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
							model?: string;
							childModel?: string;
							taskId?: string;
							answer?: string;
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
							// Send event history so client has full context
							const history = getEventHistory(msg.projectId);
							if (history.length > 0) {
								ws.send(
									JSON.stringify({
										type: "event_history",
										events: history,
									}),
								);
							}
						}

						if (msg.type === "orchestrate" && msg.projectId && msg.prompt) {
							// Trigger orchestration via launchAgent (fire-and-forget)
							const proj = pm.get(msg.projectId);
							if (proj && !activeOrchestrations.has(msg.projectId)) {
								getTracker(msg.projectId).then(() => {
									launchAgent(proj, {
										prompt: msg.prompt as string,
										model: msg.model,
										childModel: msg.childModel,
									});
								});
							} else if (activeOrchestrations.has(msg.projectId)) {
								ws.send(
									JSON.stringify({
										type: "error",
										message: "Orchestration already running",
									}),
								);
							}
						}

						if (
							msg.type === "clarify_response" &&
							msg.projectId &&
							msg.taskId &&
							msg.answer
						) {
							const session = activeSessions.get(msg.projectId as string);
							if (session) {
								try {
									session.queue.enqueue({
										source: "clarify_response",
										answer: msg.answer as string,
									});
								} catch {
									// Queue may be closed
								}
								broadcastEvent(msg.projectId as string, {
									type: "clarification_answered",
									taskId: msg.taskId,
									answer: msg.answer,
								});
							}
						}

						if (msg.type === "inject_message" && msg.projectId && msg.prompt) {
							const session = activeSessions.get(msg.projectId);
							if (session) {
								try {
									session.queue.enqueue({
										source: "user",
										content: msg.prompt,
									});
								} catch {
									// Queue may be closed
								}
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

	// Static file serving for the web UI (fallback for non-Bun environments)
	app.use("/web/*", serveStatic({ root: "./" }));

	return { app, pm, wsClients };
}

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the OpenGraft top-level orchestrator for this project.
You ONLY manage tasks — you NEVER write code yourself, not even "simple" fixes.
All implementation is done by child agents in isolated worktrees.
Exception: you MAY use edit_file to resolve merge conflicts — this is task management, not implementation.

## Your Role
- Analyze goals, decompose into tasks, spawn child agents, merge results
- Read the project's \`.opengraft/memory.md\` and \`OpenGraft.md\` to understand context and methodology
- Update \`.opengraft/memory.md\` with important decisions and discoveries (via bash)
- After merging all children, run full test suite on main to verify integration
- When everything is done and verified, call done("passed", summary) to report completion

## Session Continuity
Your session persists across conversations. When the user sends a new message:
- Check get_tree first to see current state
- Follow the stimulus priority to decide what to do next
- The user's message is additional context/instruction — incorporate it and keep driving

## Stopping
Call done("passed", summary) when all tasks are resolved (all passed/merged) and verified.
Call done("failed", summary) if you're blocked and cannot make progress.
If you need clarification on a requirement, make your best judgement and proceed — note the
decision in .opengraft/memory.md so the user can review later.

${ORCHESTRATION_KNOWLEDGE}`;

// Only start the server when run directly, not when imported for testing.
if (import.meta.main) {
	const port = Number(process.env.PORT) || 7433;
	const { app, pm } = createApp();
	await pm.load();
	console.log(`OpenGraft daemon listening on http://localhost:${port}`);
	console.log(`Web UI: http://localhost:${port}/`);
	console.log(`Provider: ${defaultConfig.agentProvider.name}`);

	// Use Bun's HTML import for the web UI (auto-bundles TSX/CSS)
	const webIndex = await import("../web/index.html");
	Bun.serve({
		routes: {
			"/": webIndex.default,
		},
		fetch: app.fetch,
		port,
		websocket,
		development: {
			hmr: true,
			console: true,
		},
	});
}
