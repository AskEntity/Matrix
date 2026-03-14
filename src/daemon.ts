import { readFileSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
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
import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider.ts";
import { ClaudeAgentSdkProvider } from "./claude-agent-sdk-provider.ts";
import { globalAgentQueues, MessageQueue } from "./message-queue.ts";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.ts";
import { loadProjectConfig, mergeProjectConfig } from "./project-config.ts";
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

/** Resolve the effective model: OG_MODEL > ANTHROPIC_MODEL > OPENAI_MODEL > undefined (provider uses its default) */
function resolveDefaultModel(): string | undefined {
	return (
		process.env.OG_MODEL ??
		process.env.ANTHROPIC_MODEL ??
		process.env.OPENAI_MODEL ??
		undefined
	);
}

function defaultProvider(): AgentProvider {
	const provider = process.env.OG_PROVIDER;
	if (provider === "openai")
		return new OpenAICompatibleProvider(resolveDefaultModel());
	if (provider === "anthropic" || provider === "direct")
		return new AnthropicCompatibleProvider(resolveDefaultModel());
	if (provider === "claude-code") return new ClaudeAgentSdkProvider();

	// Auto-detect from model name
	const model = resolveDefaultModel();
	if (model && /^(gpt-|o1-|o3-|o4-|deepseek-)/.test(model)) {
		return new OpenAICompatibleProvider(model);
	}

	// Default: Anthropic API
	return new AnthropicCompatibleProvider(resolveDefaultModel());
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
	/*
	 * Agent Lifecycle:
	 *   IDLE → STARTING → RUNNING → STOPPING → IDLE
	 *
	 *   IDLE:     No active session. Can start via /orchestrate/agent or WS orchestrate.
	 *   STARTING: launchAgent() called, session being created. Guard: startupReady check.
	 *   RUNNING:  Session in activeSessions map. Can inject messages, clarify, restart.
	 *   STOPPING: stopAgent() called. Cleanup in progress. Guard: restartingProjects set.
	 *
	 *   State is determined by activeSessions.has(projectId).
	 *   The restartingProjects set prevents concurrent stop+start during restart.
	 *   All stop/cleanup goes through stopAgent() — single path for lifecycle transitions.
	 */
	const app = new Hono();
	let requestCount = 0;
	let startupReady = false;
	app.use("*", async (_c, next) => {
		requestCount++;
		await next();
	});
	const pm = new ProjectManager(config.dataDir);
	const trackers = new Map<string, TaskTracker>();
	/** Guard against concurrent restart requests for the same project. */
	const restartingProjects = new Set<string>();
	const wsClients = new Set<WSClient>();
	/** Active agent sessions by project ID, for message injection. */
	const activeSessions = new Map<string, AgentSession>();
	/** Event history per project (capped at 500 entries, persisted to disk). */
	const eventHistory = new Map<string, Record<string, unknown>[]>();
	const MAX_EVENT_HISTORY = 500;
	const eventsDirty = new Set<string>();
	let eventFlushTimer: ReturnType<typeof setTimeout> | null = null;

	/** Pending messages per project — user messages waiting to be consumed by agents. */
	interface PendingMessage {
		id: string;
		taskId: string | null;
		text: string;
		timestamp: number;
	}
	const pendingMessages = new Map<string, PendingMessage[]>();

	function getPendingMessages(projectId: string): PendingMessage[] {
		if (!pendingMessages.has(projectId)) pendingMessages.set(projectId, []);
		return pendingMessages.get(projectId) as PendingMessage[];
	}

	function addPendingMessage(
		projectId: string,
		taskId: string | null,
		text: string,
	): void {
		const msgs = getPendingMessages(projectId);
		msgs.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			taskId,
			text,
			timestamp: Date.now(),
		});
		broadcast(wsClients, projectId, {
			type: "pending_messages",
			projectId,
			messages: msgs,
		});
	}

	function removePendingMessagesByText(
		projectId: string,
		textsToRemove: string[],
	): void {
		const msgs = getPendingMessages(projectId);
		let changed = false;
		for (const text of textsToRemove) {
			const idx = msgs.findIndex((m) => m.text === text);
			if (idx !== -1) {
				msgs.splice(idx, 1);
				changed = true;
			}
		}
		if (changed) {
			broadcast(wsClients, projectId, {
				type: "pending_messages",
				projectId,
				messages: msgs,
			});
		}
	}

	/** Pending clarifications per project — clarify() calls waiting for user answers. */
	interface PendingClarification {
		id: string;
		taskId: string;
		question: string;
		timestamp: number;
	}
	const pendingClarifications = new Map<string, PendingClarification[]>();

	function getPendingClarifications(projectId: string): PendingClarification[] {
		if (!pendingClarifications.has(projectId))
			pendingClarifications.set(projectId, []);
		return pendingClarifications.get(projectId) as PendingClarification[];
	}

	function addPendingClarification(
		projectId: string,
		taskId: string,
		question: string,
	): PendingClarification {
		const clarifications = getPendingClarifications(projectId);
		const entry: PendingClarification = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			taskId,
			question,
			timestamp: Date.now(),
		};
		clarifications.push(entry);
		broadcast(wsClients, projectId, {
			type: "pending_clarifications",
			projectId,
			clarifications,
		});
		return entry;
	}

	function removePendingClarification(
		projectId: string,
		taskId: string,
		clarificationId?: string,
	): void {
		const clarifications = getPendingClarifications(projectId);
		const idx = clarificationId
			? clarifications.findIndex((c) => c.id === clarificationId)
			: clarifications.findIndex((c) => c.taskId === taskId);
		if (idx !== -1) {
			clarifications.splice(idx, 1);
			broadcast(wsClients, projectId, {
				type: "pending_clarifications",
				projectId,
				clarifications,
			});
		}
	}

	function eventsPath(projectId: string): string {
		return join(config.dataDir, "events", `${projectId}.json`);
	}

	async function loadEventHistory(
		projectId: string,
	): Promise<Record<string, unknown>[]> {
		const path = eventsPath(projectId);
		try {
			const raw = await readFile(path, "utf-8");
			const events = JSON.parse(raw) as Record<string, unknown>[];
			eventHistory.set(projectId, events);
			return events;
		} catch {
			const events: Record<string, unknown>[] = [];
			eventHistory.set(projectId, events);
			return events;
		}
	}

	async function flushEvents(): Promise<void> {
		const dirty = [...eventsDirty];
		eventsDirty.clear();
		const eventsDir = join(config.dataDir, "events");
		await mkdir(eventsDir, { recursive: true });
		for (const projectId of dirty) {
			const history = eventHistory.get(projectId);
			if (history) {
				try {
					await writeFile(
						eventsPath(projectId),
						JSON.stringify(history),
						"utf-8",
					);
				} catch {
					/* non-fatal */
				}
			}
		}
	}

	function scheduleEventFlush(projectId: string): void {
		eventsDirty.add(projectId);
		if (!eventFlushTimer) {
			eventFlushTimer = setTimeout(async () => {
				eventFlushTimer = null;
				await flushEvents();
			}, 2000); // batch writes every 2s
		}
	}

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
			scheduleEventFlush(projectId);
		}
		broadcast(wsClients, projectId, event);

		// Auto-remove pending messages when queue_message events fire (agent consumed the message)
		if (
			event.type === "agent_event" &&
			event.eventType === "queue_message" &&
			typeof event.messages === "string"
		) {
			const raw = event.messages as string;
			const acknowledgedTexts: string[] = [];
			// Split on newlines followed by [ to handle multiline message content
			const blocks = raw.split(/\n(?=\[)/);
			for (const block of blocks) {
				const m = /^\[user\] ([\s\S]*)$/.exec(block);
				if (m?.[1]) acknowledgedTexts.push(m[1]);
			}
			if (acknowledgedTexts.length > 0) {
				removePendingMessagesByText(projectId, acknowledgedTexts);
			}
		}

		// Track clarification_requested events for Web UI display
		if (
			event.type === "clarification_requested" &&
			typeof event.taskId === "string" &&
			typeof event.question === "string"
		) {
			addPendingClarification(projectId, event.taskId, event.question);
		}
	}

	/**
	 * Stop a running agent and clean up all associated state.
	 * Single path for all stop operations (explicit stop, restart, project delete).
	 *
	 * @param opts.clearAutoResume - Set true for explicit stops (user stop, project delete).
	 *   Leave false for restart (autoResume should persist).
	 * @param opts.keepPendingMessages - Set true during restart so pending user messages
	 *   survive for the new session to consume.
	 */
	async function stopAgent(
		projectId: string,
		opts?: { clearAutoResume?: boolean; keepPendingMessages?: boolean },
	): Promise<void> {
		const session = activeSessions.get(projectId);
		if (!session) return;

		// Save session for future resume
		const tracker = trackers.get(projectId);
		if (tracker && session.sessionId) {
			tracker.orchestratorSessionId = session.sessionId;
			if (opts?.clearAutoResume) {
				tracker.autoResume = false;
			}
			await tracker.save();
		}

		session.stop();
		activeSessions.delete(projectId);

		// Clear pending state
		if (!opts?.keepPendingMessages) {
			pendingMessages.delete(projectId);
			broadcast(wsClients, projectId, {
				type: "pending_messages",
				projectId,
				messages: [],
			});
		}
		pendingClarifications.delete(projectId);
		broadcast(wsClients, projectId, {
			type: "pending_clarifications",
			projectId,
			clarifications: [],
		});

		broadcastEvent(projectId, { type: "agent_stopped" });
	}

	/**
	 * Prune old session files, keeping only the most recent N.
	 * Used by autoResumeProjects (startup) and POST /sessions/prune.
	 */
	async function pruneSessionFiles(
		projectId: string,
		keepCount: number,
	): Promise<{ pruned: number; remaining: number }> {
		const sessionsDir = join(config.dataDir, "sessions", projectId);
		try {
			const files = await readdir(sessionsDir).catch(() => []);
			const jsonFiles = files.filter((f) => f.endsWith(".json"));

			if (jsonFiles.length <= keepCount) {
				return { pruned: 0, remaining: jsonFiles.length };
			}

			const withMtime = await Promise.all(
				jsonFiles.map(async (f) => ({
					name: f,
					mtime: (await stat(join(sessionsDir, f))).mtimeMs,
				})),
			);
			withMtime.sort((a, b) => b.mtime - a.mtime);

			const toDelete = withMtime.slice(keepCount);
			await Promise.all(toDelete.map((f) => unlink(join(sessionsDir, f.name))));

			return { pruned: toDelete.length, remaining: keepCount };
		} catch {
			return { pruned: 0, remaining: 0 };
		}
	}

	/** Read project files and format as pre-read context for the agent. */
	function readProjectMemory(projectPath: string): string {
		const parts: string[] = [];

		parts.push(
			"The following files have been pre-read for you. Do NOT re-read them unless you need to check for updates.",
		);

		// Read CLAUDE.md for project architecture context
		try {
			const claudeMd = readFileSync(join(projectPath, "CLAUDE.md"), "utf-8");
			if (claudeMd) parts.push(`[read_file: CLAUDE.md]\n${claudeMd}`);
		} catch {
			// No CLAUDE.md, that's fine
		}

		// Read .opengraft/memory.md for agent-specific memory
		try {
			const memory = readFileSync(
				join(projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
			if (memory) parts.push(`[read_file: .opengraft/memory.md]\n${memory}`);
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

	// --- Shared handlers (used by both REST routes and WS messages) ---

	/** Start orchestration for a project. Used by POST /orchestrate/agent and WS orchestrate. */
	async function handleOrchestrate(
		projectId: string,
		prompt: string,
		opts: { resume?: boolean; model?: string; childModel?: string },
	): Promise<{ ok: boolean; error?: string; status?: number }> {
		if (!startupReady) {
			return {
				ok: false,
				error: "Server starting up, please wait...",
				status: 503,
			};
		}
		const project = pm.get(projectId);
		if (!project) {
			return { ok: false, error: "Project not found", status: 404 };
		}
		if (activeSessions.has(projectId) || restartingProjects.has(projectId)) {
			return {
				ok: false,
				error: "Agent already running for this project",
				status: 409,
			};
		}
		await getTracker(projectId);
		await launchAgent(project, { prompt, ...opts });
		return { ok: true };
	}

	/** Inject a user message into a running agent. Used by POST /message and WS inject_message. */
	function handleInjectMessage(
		projectId: string,
		message: string,
	): { ok: boolean; error?: string; status?: number; sessionId?: string } {
		const session = activeSessions.get(projectId);
		if (!session) {
			return {
				ok: false,
				error: "No active session for this project",
				status: 404,
			};
		}
		try {
			session.queue.enqueue({ source: "user", content: message });
		} catch {
			return { ok: false, error: "Queue closed", status: 409 };
		}
		addPendingMessage(projectId, null, message);
		return { ok: true, sessionId: session.sessionId };
	}

	/** Answer a pending clarification. Used by POST /clarify and WS clarify_response. */
	function handleClarifyResponse(
		projectId: string,
		taskId: string,
		answer: string,
		clarificationId?: string,
	): { ok: boolean; error?: string; status?: number } {
		const session = activeSessions.get(projectId);
		if (!session) {
			return {
				ok: false,
				error: "No active session for this project",
				status: 404,
			};
		}
		try {
			session.queue.enqueue({ source: "clarify_response", answer });
		} catch {
			return { ok: false, error: "Queue closed", status: 409 };
		}
		removePendingClarification(projectId, taskId, clarificationId);
		broadcastEvent(projectId, {
			type: "clarification_answered",
			taskId,
			answer,
		});
		return { ok: true };
	}

	// Health
	app.get("/health", async (c) => {
		const response: HealthResponse = {
			status: "ok",
			version: VERSION,
			uptime: Date.now() - startTime,
		};

		if (c.req.query("check_model") === "true") {
			const modelName = resolveDefaultModel() ?? "claude-sonnet-4-6";
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

	// Restart daemon
	app.post("/restart-daemon", async (c) => {
		await shutdown();
		const uid = process.getuid?.() ?? 501;
		const label = "com.opengraft.daemon";
		const proc = Bun.spawn(
			["launchctl", "kickstart", "-kp", `gui/${uid}/${label}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			// Fallback: just exit and let launchd restart us
			process.exit(0);
		}
		return c.json({ ok: true });
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
		const projectId = c.req.param("id");
		await stopAgent(projectId, { clearAutoResume: true });
		try {
			await pm.delete(projectId);
			// Clean up all in-memory state for this project
			trackers.delete(projectId);
			pendingMessages.delete(projectId);
			pendingClarifications.delete(projectId);
			eventHistory.delete(projectId);
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 404);
		}
	});

	// Event history
	app.get("/projects/:id/events", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const events = eventHistory.has(project.id)
			? (eventHistory.get(project.id) as Record<string, unknown>[])
			: await loadEventHistory(project.id);
		return c.json({ events });
	});

	// Pending messages
	app.get("/projects/:id/pending-messages", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({ messages: getPendingMessages(project.id) });
	});

	// Pending clarifications
	app.get("/projects/:id/clarifications", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({ clarifications: getPendingClarifications(project.id) });
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
			budgetUsd?: number;
		}>();
		if (!body.title) {
			return c.json({ error: "title is required" }, 400);
		}

		const tracker = await getTracker(project.id);
		const opts =
			body.budgetUsd !== undefined ? { budgetUsd: body.budgetUsd } : undefined;
		try {
			const node = body.parentId
				? tracker.addChild(
						body.parentId,
						body.title,
						body.description ?? "",
						opts,
					)
				: tracker.addTask(body.title, body.description ?? "", opts);
			await tracker.save();
			broadcastTreeUpdate(project.id, tracker);
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
			title?: string;
			description?: string;
			draft?: boolean;
		}>();
		if (body.status) {
			tracker.updateStatus(nodeId, body.status);
		}
		if (body.branch) {
			tracker.assignBranch(nodeId, body.branch);
		}
		if (body.title) {
			tracker.updateTitle(node.id, body.title);
		}
		if (body.description !== undefined) {
			tracker.updateDescription(node.id, body.description);
		}
		if (body.draft !== undefined) {
			tracker.updateDraft(node.id, body.draft);
		}
		await tracker.save();
		broadcastTreeUpdate(project.id, tracker);
		return c.json(tracker.get(nodeId));
	});

	async function runChildAgentInBackground(
		project: { id: string; path: string },
		tracker: TaskTracker,
		nodeId: string,
		prompt: string,
		_model?: string,
	): Promise<void> {
		const node = tracker.get(nodeId);
		if (!node?.worktreePath) return;
		const childQueue = new MessageQueue();
		globalAgentQueues.set(nodeId, childQueue);
		try {
			const wtRoot = join(project.path, ".worktrees");
			const wm = new WorktreeManager(project.path, wtRoot);
			const costAccumulator = new CostAccumulator();
			const doneRef: {
				done: null | { status: "passed" | "failed"; summary: string };
			} = { done: null };
			const continueCfg = await loadProjectConfig(config.dataDir, project.id);

			const { mcpServer, toolDefs, hasRunningChildren } =
				createOrchestratorTools(
					{
						tracker,
						provider: config.agentProvider,
						worktrees: wm,
						projectPath: node.worktreePath as string,
						repoPath: project.path,
						currentTaskId: nodeId,
						depth: 1,
						queue: childQueue,
						doneRef,
						defaultBudgetUsd: continueCfg.budgetUsd,
						clarifyTimeoutMs: continueCfg.clarifyTimeoutMs,
						maxDepth: continueCfg.maxDepth,
						onTaskEvent: (event) => {
							broadcastEvent(project.id, event);
							broadcastTreeUpdate(project.id, tracker);
						},
						broadcastTreeUpdate: () => broadcastTreeUpdate(project.id, tracker),
					},
					costAccumulator,
				);

			const session = config.agentProvider.startSession({
				prompt,
				cwd: node.worktreePath as string,
				systemPrompt: TASK_SYSTEM_PROMPT,
				resumeSessionId: node.sessionId ?? undefined,
				model: continueCfg.model ?? resolveDefaultModel() ?? undefined,
				mcpServers: { opengraft: mcpServer },
				mcpToolDefs: { opengraft: toolDefs },
				queue: childQueue,
				doneRef,
				hasRunningChildren,
			});

			let result = await session.events.next();
			while (!result.done) {
				const { type: eventType, ...eventData } = result.value;
				broadcastEvent(project.id, {
					type: "agent_event",
					taskId: nodeId,
					eventType,
					...eventData,
				});
				result = await session.events.next();
			}
			const agentResult = result.value;

			if (agentResult.sessionId) {
				tracker.assignSession(nodeId, agentResult.sessionId);
			}
			// Use doneRef if available; fall back to agentResult.success
			const didPass = doneRef.done
				? doneRef.done.status === "passed"
				: agentResult.success;
			const newStatus = didPass ? "passed" : "failed";
			tracker.updateStatus(nodeId, newStatus);
			await tracker.save();
			broadcastEvent(project.id, {
				type: "task_completed",
				taskId: nodeId,
				title: node.title,
				success: didPass,
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
		} finally {
			globalAgentQueues.delete(nodeId);
			childQueue.close();
		}
	}

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
			runChildAgentInBackground(
				project,
				tracker,
				nodeId,
				continuePrompt,
				body.model,
			);

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
		broadcastTreeUpdate(project.id, tracker);
		return c.json({ ok: true });
	});

	// Git log for a task branch
	app.get("/projects/:id/tasks/:nodeId/gitlog", async (c) => {
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
		if (!node.worktreePath || !node.branch) {
			return c.json({ commits: [] });
		}
		try {
			const proc = Bun.spawn(["git", "log", "--oneline", "-20", node.branch], {
				cwd: project.path,
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;
			const output = await new Response(proc.stdout).text();
			const commits = output
				.trim()
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => {
					const spaceIdx = line.indexOf(" ");
					return {
						hash: spaceIdx >= 0 ? line.slice(0, spaceIdx) : line,
						message: spaceIdx >= 0 ? line.slice(spaceIdx + 1) : "",
					};
				});
			return c.json({ commits });
		} catch {
			return c.json({ commits: [] });
		}
	});

	// Conversation history for a task (from session file)
	app.get("/projects/:id/tasks/:nodeId/conversation", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const tracker = await getTracker(project.id);
		const node = tracker.get(c.req.param("nodeId"));
		if (!node) return c.json({ error: "Task not found" }, 404);
		if (!node.sessionId) return c.json({ messages: [] });
		const sessionPath = join(
			config.dataDir,
			"sessions",
			project.id,
			`${node.sessionId}.json`,
		);
		try {
			const raw = await readFile(sessionPath, "utf-8");
			const params = JSON.parse(raw) as Array<{
				role: string;
				content: unknown;
			}>;
			const messages = params.slice(-100).map((msg) => {
				let content = "";
				let hasToolUse = false;
				const toolNames: string[] = [];
				if (typeof msg.content === "string") {
					content = msg.content;
				} else if (Array.isArray(msg.content)) {
					for (const block of msg.content as Array<{
						type: string;
						text?: string;
						name?: string;
					}>) {
						if (block.type === "text" && block.text)
							content += (content ? "\n" : "") + block.text;
						else if (block.type === "tool_use" && block.name) {
							hasToolUse = true;
							toolNames.push(block.name);
						}
					}
				}
				return {
					role: msg.role,
					content,
					hasToolUse,
					...(toolNames.length ? { toolNames } : {}),
				};
			});
			return c.json({ messages });
		} catch {
			return c.json({ messages: [] });
		}
	});

	/**
	 * Launch an agent for a project. Returns immediately.
	 * The agent runs in the background; observe via WebSocket.
	 * Uses startSession() for message injection support.
	 */
	async function launchAgent(
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

		// Load project config for model override (set via settings UI)
		const projectCfg = await loadProjectConfig(config.dataDir, project.id);
		// Priority: API param > project config > env var
		const effectiveModel =
			opts.model ?? projectCfg.model ?? resolveDefaultModel() ?? undefined;
		const effectiveChildModel =
			opts.childModel ??
			projectCfg.childModel ??
			resolveDefaultModel() ??
			undefined;

		// Mark project for auto-resume on daemon restart
		tracker.autoResume = true;
		tracker.save().catch(() => {});

		broadcastEvent(project.id, {
			type: "orchestration_started",
			prompt: opts.prompt,
			provider: config.agentProvider.name,
			model: effectiveModel ?? resolveDefaultModel() ?? "claude-sonnet-4-6",
		});

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
				childModel: effectiveChildModel,
				queue,
				doneRef,
				defaultBudgetUsd: projectCfg.budgetUsd,
				clarifyTimeoutMs: projectCfg.clarifyTimeoutMs,
				maxDepth: projectCfg.maxDepth,
				onTaskEvent: (event) => {
					broadcastEvent(project.id, event);
					broadcastTreeUpdate(project.id, tracker);
				},
				broadcastTreeUpdate: () => broadcastTreeUpdate(project.id, tracker),
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
				? `${memory}\n\n---\n\n${opts.prompt}`
				: opts.prompt;

		const resumeSessionId = shouldResume
			? (tracker.orchestratorSessionId ?? undefined)
			: undefined;

		// Use startSession for message injection support
		const session = config.agentProvider.startSession({
			prompt,
			cwd: project.path,
			projectPath: project.path,
			sessionsDir: join(config.dataDir, "sessions", project.id),
			systemPrompt: `${ORCHESTRATOR_SYSTEM_PROMPT}\n\n${ORCHESTRATION_KNOWLEDGE}`,
			mcpServers: { opengraft: mcpServer },
			mcpToolDefs: { opengraft: toolDefs },
			resumeSessionId,
			model: effectiveModel,
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
					inputTokens: finalResult.inputTokens,
					cacheCreationTokens: finalResult.cacheCreationTokens,
					cacheReadTokens: finalResult.cacheReadTokens,
					outputTokens: finalResult.outputTokens,
					childCosts: {
						totalCostUsd: costAccumulator.totalCostUsd,
						totalTurns: costAccumulator.totalTurns,
						taskCount: costAccumulator.taskCount,
					},
				});
				broadcastTreeUpdate(project.id, tracker);

				// Clear auto-resume on normal completion (not during restart)
				if (activeSessions.get(project.id) === session) {
					tracker.autoResume = false;
				}
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
				// Only clean up if this session is still the active one.
				// During restart, a new session replaces us — don't clobber it.
				if (activeSessions.get(project.id) === session) {
					activeSessions.delete(project.id);
				}
			}
		})();
	}

	// Agent-driven orchestration: fire-and-forget, observe via WebSocket
	app.post("/projects/:id/orchestrate/agent", async (c) => {
		const body = await c.req.json<{
			prompt: string;
			resume?: boolean;
			model?: string;
			childModel?: string;
		}>();
		if (!body.prompt && !body.resume) {
			return c.json({ error: "prompt is required" }, 400);
		}

		const result = await handleOrchestrate(
			c.req.param("id"),
			body.prompt,
			body,
		);
		if (!result.ok) {
			return c.json({ error: result.error }, result.status as 404);
		}
		return c.json({ status: "running", projectId: c.req.param("id") });
	});

	// Start agent by project path (auto-creates project if needed)
	app.post("/agents/start", async (c) => {
		if (!startupReady) {
			return c.json({ error: "Server starting up, please wait..." }, 503);
		}
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

		if (activeSessions.has(project.id) || restartingProjects.has(project.id)) {
			return c.json({ error: "Agent already running for this project" }, 409);
		}

		await getTracker(project.id);
		await launchAgent(project, body);
		return c.json({ status: "running", projectId: project.id });
	});

	// Project config CRUD
	app.get("/projects/:id/config", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const cfg = await loadProjectConfig(config.dataDir, project.id);
		return c.json(cfg);
	});

	app.patch("/projects/:id/config", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const partial = await c.req.json();
		const merged = await mergeProjectConfig(
			config.dataDir,
			project.id,
			partial,
		);
		return c.json(merged);
	});

	app.get("/projects/:id/agent", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const session = activeSessions.get(project.id);
		const projectCfg = await loadProjectConfig(config.dataDir, project.id);
		const model =
			projectCfg.model ?? resolveDefaultModel() ?? "claude-sonnet-4-6";
		return c.json({
			running: !!session,
			sessionId: session?.sessionId ?? null,
			provider: config.agentProvider.name,
			model,
		});
	});

	// Stop a running agent
	app.post("/projects/:id/stop", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		if (!activeSessions.has(project.id)) {
			return c.json({ error: "No active agent for this project" }, 404);
		}
		await stopAgent(project.id, { clearAutoResume: true });
		return c.json({ ok: true });
	});

	// Restart orchestrator: stop current session, relaunch with resume:true
	app.post("/projects/:id/restart", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		if (restartingProjects.has(project.id)) {
			return c.json({ error: "Restart already in progress" }, 409);
		}
		if (!activeSessions.has(project.id)) {
			return c.json({ error: "No active agent to restart" }, 404);
		}

		restartingProjects.add(project.id);
		try {
			// Keep pending messages so the restarted agent can consume them
			await stopAgent(project.id, { keepPendingMessages: true });

			// Relaunch with resume to pick up new config
			await launchAgent(project, {
				prompt:
					"Orchestrator restarted to pick up new config. Continue where you left off.",
				resume: true,
			});
			return c.json({ ok: true });
		} finally {
			restartingProjects.delete(project.id);
		}
	});

	// Clear session history for a project (useful when starting fresh after restart)
	app.post("/projects/:id/sessions/clear", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		if (activeSessions.has(project.id)) {
			return c.json(
				{
					error:
						"Cannot clear sessions while agent is running. Stop the agent first.",
				},
				409,
			);
		}
		const sessionsDir = join(config.dataDir, "sessions", project.id);
		await rm(sessionsDir, { recursive: true, force: true });
		await mkdir(sessionsDir, { recursive: true });
		// Also clear event history and disable auto-resume
		eventHistory.delete(project.id);
		try {
			await rm(eventsPath(project.id));
		} catch {
			/* ok */
		}
		const tracker = trackers.get(project.id);
		if (tracker) {
			tracker.autoResume = false;
			tracker.orchestratorSessionId = null;
			await tracker.save();
		}
		return c.json({ cleared: true });
	});

	// Prune old session files (keep only the most recent N)
	app.post("/projects/:id/sessions/prune", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);

		const body = await c.req
			.json<{ keepCount?: number }>()
			.catch(() => ({}) as { keepCount?: number });
		const keepCount = body?.keepCount ?? 10;

		const result = await pruneSessionFiles(project.id, keepCount);
		return c.json(result);
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

		const result = handleInjectMessage(project.id, body.message);
		if (!result.ok) {
			return c.json({ error: result.error }, result.status as 404);
		}
		return c.json({ ok: true, sessionId: result.sessionId });
	});

	// Inject a message into a specific running child agent's queue
	app.post("/projects/:id/tasks/:nodeId/message", async (c) => {
		const project = pm.get(c.req.param("id"));
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		const nodeId = c.req.param("nodeId");
		const body = await c.req.json<{ content: string }>();
		if (!body.content) {
			return c.json({ error: "content is required" }, 400);
		}

		const queue = globalAgentQueues.get(nodeId);
		if (!queue) {
			return c.json({ error: "No active agent for this task" }, 404);
		}

		try {
			queue.enqueue({ source: "user", content: body.content });
		} catch {
			return c.json({ error: "Queue closed" }, 409);
		}
		addPendingMessage(project.id, nodeId, body.content);
		return c.json({ ok: true, taskId: nodeId });
	});

	// Respond to a pending clarification request
	app.post("/projects/:id/clarify", async (c) => {
		const projectId = c.req.param("id");
		const body = await c.req.json<{
			taskId: string;
			answer: string;
			clarificationId?: string;
		}>();
		if (!body.taskId || !body.answer) {
			return c.json({ error: "taskId and answer are required" }, 400);
		}

		const result = handleClarifyResponse(
			projectId,
			body.taskId,
			body.answer,
			body.clarificationId,
		);
		if (!result.ok) {
			return c.json({ error: result.error }, result.status as 404);
		}
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
				async onMessage(evt, ws) {
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
							let tracker = trackers.get(msg.projectId);
							if (!tracker) {
								// Load tracker if not in memory yet
								try {
									tracker = await getTracker(msg.projectId);
								} catch {
									/* project data not found — ok */
								}
							}
							if (tracker) {
								ws.send(
									JSON.stringify({
										type: "tree_updated",
										nodes: tracker.allNodes(),
									}),
								);
							}
							// Send event history so client has full context (load from disk if needed)
							let history = eventHistory.get(msg.projectId);
							if (!history) {
								history = await loadEventHistory(msg.projectId);
							}
							if (history.length > 0) {
								ws.send(
									JSON.stringify({
										type: "event_history",
										events: history,
									}),
								);
							}
							// Send current pending messages
							const pending = getPendingMessages(msg.projectId);
							if (pending.length > 0) {
								ws.send(
									JSON.stringify({
										type: "pending_messages",
										projectId: msg.projectId,
										messages: pending,
									}),
								);
							}
							// Send current pending clarifications
							const clarifications = getPendingClarifications(msg.projectId);
							if (clarifications.length > 0) {
								ws.send(
									JSON.stringify({
										type: "pending_clarifications",
										projectId: msg.projectId,
										clarifications,
									}),
								);
							}
						}

						if (msg.type === "orchestrate" && msg.projectId && msg.prompt) {
							const result = await handleOrchestrate(
								msg.projectId,
								msg.prompt,
								{ model: msg.model, childModel: msg.childModel },
							);
							if (!result.ok) {
								ws.send(
									JSON.stringify({ type: "error", message: result.error }),
								);
							}
						}

						if (
							msg.type === "clarify_response" &&
							msg.projectId &&
							msg.taskId &&
							msg.answer
						) {
							// Errors silently ignored for WS clarify (matches previous behavior)
							handleClarifyResponse(msg.projectId, msg.taskId, msg.answer);
						}

						if (msg.type === "inject_message" && msg.projectId && msg.prompt) {
							const result = handleInjectMessage(msg.projectId, msg.prompt);
							if (result.ok) {
								broadcastEvent(msg.projectId, {
									type: "message_injected",
									message: msg.prompt,
								});
							} else {
								ws.send(
									JSON.stringify({ type: "error", message: result.error }),
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

	/** Auto-resume orchestrations that were running before daemon restart. */
	async function autoResumeProjects(): Promise<void> {
		const sessionKeep = Number.parseInt(process.env.OG_SESSION_KEEP ?? "5", 10);
		const projects = pm.list();
		for (const project of projects) {
			// Auto-prune old session files to prevent unbounded disk growth
			const result = await pruneSessionFiles(project.id, sessionKeep);
			if (result.pruned > 0) {
				console.log(
					`Auto-pruned ${result.pruned} old session(s) for ${project.name}`,
				);
			}

			const tracker = await getTracker(project.id);
			if (tracker.autoResume && tracker.orchestratorSessionId) {
				// Reset orphaned in_progress tasks — their agent sessions died with the daemon
				let orphanCount = 0;
				for (const node of tracker.allNodes()) {
					if (node.status === "in_progress") {
						tracker.updateStatus(node.id, "failed");
						orphanCount++;
					}
				}
				if (orphanCount > 0) await tracker.save();

				// Load event history from disk so UI can show previous logs
				await loadEventHistory(project.id);
				console.log(
					`Auto-resuming orchestration for ${project.name} (${project.id.slice(0, 8)})`,
				);
				const resumePrompt = `Continue where you left off. The daemon restarted.${orphanCount > 0 ? ` Note: ${orphanCount} in_progress task(s) were reset to failed.` : ""} Check the task tree and proceed.`;
				await launchAgent(project, {
					prompt: resumePrompt,
					resume: true,
				});
			}
		}
	}

	/** Graceful shutdown: save all active session IDs and flush events. */
	async function shutdown(): Promise<void> {
		// Stop all agents — don't clear autoResume so they resume on next start
		const projectIds = [...activeSessions.keys()];
		for (const projectId of projectIds) {
			await stopAgent(projectId);
		}
		await flushEvents();
	}

	function markReady() {
		startupReady = true;
	}

	return {
		app,
		pm,
		wsClients,
		autoResumeProjects,
		shutdown,
		getTracker,
		markReady,
	};
}

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the OpenGraft top-level orchestrator for this project.
You ONLY manage tasks — you NEVER write code yourself, not even "simple" fixes.
All implementation is done by child agents in isolated worktrees.
Exception: you MAY use edit_file to resolve merge conflicts — this is task management, not implementation.

## Built-in Tools
You have these tools for exploring the codebase and managing merges:
- read_file: Read file contents (use this instead of bash cat)
- search: Regex search across files (use this instead of bash grep/rg)
- list_files: Glob pattern matching (use this instead of bash find/ls)
- edit_file: Edit files (for merge conflict resolution only)
- bash: Shell commands (for git, tests, og daemon restart — NOT for reading files)
  Working directory is automatically tracked across calls — if you \`cd\` in one command,
  subsequent commands run from the new directory. Do NOT prefix every command with \`cd /path &&\`.

Do NOT use bash to read files (cat, head, tail) or search (grep, rg). Use the dedicated tools.

## Your Role
- Analyze goals, decompose into tasks, spawn child agents, merge results
- Read the project's \`.opengraft/memory.md\` and \`OpenGraft.md\` to understand context and methodology
- Update \`.opengraft/memory.md\` with important decisions and discoveries (via bash)
- After merging all children, run full test suite on main to verify integration
- When everything is done and verified, call done("passed", summary) to report completion

## Orchestration Philosophy
- **Always create tasks** — don't use "wait for previous task" as an excuse to not create one. Task descriptions can be updated later. Parallel by default. Most tasks have independent scopes.
- **Parallel by default** — sibling tasks run in parallel. Only serialize when truly dependent (e.g. "types first, then implementation").
- **Only skip creating** when a task is so heavily dependent that even scoping is impossible (extremely rare). Conflicts are normal and expected — git merges resolve them.
- **Prefer deep trees** over flat lists — each level multiplies parallelism.
- **Draft every idea** — when the user mentions ANY idea, bug, or feature (even half-formed), immediately create a draft task (\`draft: true\`). Drafts are cheap, lost context is expensive. Don't wait for "create a task" — if it's worth doing, draft it now.

## Maximize Parallelism
The task tree is a TREE, not a flat list. Decompose work to maximize parallel execution:
- Split into independent subtasks that can run simultaneously on separate branches
- Each level of the tree multiplies parallelism — prefer deep parallel trees over shallow sequential lists
- A child that receives a complex task should further decompose it into its own children
- Only serialize tasks that truly depend on each other (e.g., "types first, then implementation")

## Orchestration Philosophy
- **Always create tasks** — don't use "wait for previous task" as an excuse to not create one. Task descriptions can be updated later. Parallel by default. Most tasks have independent scopes.
- **Only skip creating** when a task is so heavily dependent that even scoping is impossible (extremely rare). Conflicts are normal and expected — git merges resolve them.
- **Prefer deep trees** over flat lists — each level multiplies parallelism.

## Task Decomposition
When decomposing work, write **high-quality task descriptions** for each child. Good task descriptions:
- State the GOAL clearly (what should be different when the task is done)
- Specify which files/modules are in scope — be explicit, not vague
- Describe the expected approach or constraints (e.g. "add a new route", "modify the existing handler")
- Note dependencies: "this task can be tested independently" or "depends on sibling X being merged first"
- Include relevant context the child needs (API signatures, type definitions, design decisions)

Bad: "Add authentication". Good: "Add JWT auth middleware in src/middleware/auth.ts that validates
Bearer tokens from the Authorization header. Use the existing User type from src/types.ts. Add tests
in src/middleware/auth.test.ts. This is independently testable."

## Review Before Merge
After a child passes and before merging:
- Read the child's completion summary and any child_report messages carefully
- After merging, run the test suite to verify integration
- If the merged code introduces issues, either fix via a new task or reset

## Stopping
Call done("passed", summary) when all tasks are resolved (all passed/merged) and verified.
Call done("failed", summary) if you're blocked and cannot make progress.
Never stop just because you finished responding — check get_tree and keep driving.

## Output Efficiency
Be concise. Don't narrate — act. When thinking through a plan, keep it brief. Don't repeat
information from memory.md or the task tree back. Your token budget matters.

${ORCHESTRATION_KNOWLEDGE}`;

// Only start the server when run directly, not when imported for testing.
if (import.meta.main) {
	const port = Number(process.env.PORT) || 7433;
	const { app, pm, autoResumeProjects, shutdown, markReady } = createApp();
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

	// Graceful shutdown: save sessions before exit
	const handleShutdown = async () => {
		console.log("Shutting down — saving sessions...");
		await shutdown();
		process.exit(0);
	};
	process.on("SIGTERM", handleShutdown);
	process.on("SIGINT", handleShutdown);

	// Auto-resume any orchestrations that were running before daemon restart
	await autoResumeProjects();
	markReady();
}
