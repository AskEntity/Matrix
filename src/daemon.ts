import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { AgentSession } from "./agent-provider.ts";
import { DEFAULT_MODEL, loadGlobalConfig, resolveAuthGroup } from "./config.ts";
import {
	launchAgent,
	runChildAgentInBackground,
	stopAgent,
	writeOrphanedToolResults,
} from "./daemon/agent-lifecycle.ts";
import type {
	DaemonConfig,
	DaemonContext,
	PendingClarification,
	SSEClient,
} from "./daemon/context.ts";
import {
	getEventStore,
	getTracker,
	readProjectMemory,
} from "./daemon/helpers.ts";
import { registerAgentRoutes } from "./daemon/routes/agent.ts";
import {
	createAuthMiddleware,
	registerAuthRoutes,
} from "./daemon/routes/auth.ts";
import { registerConfigRoutes } from "./daemon/routes/config.ts";
import { registerProjectRoutes } from "./daemon/routes/projects.ts";
import { registerSSERoute } from "./daemon/routes/sse.ts";
import { registerTaskRoutes } from "./daemon/routes/tasks.ts";
import { findOrphanedBackgroundProcesses, hasPendingYield } from "./events.ts";
import { persistMessage } from "./persistent-queue.ts";
import { ProjectManager } from "./project-manager.ts";
import { buildSystemPrompt } from "./system-prompts.ts";
import type {
	HealthResponse,
	StatsResponse,
	VersionResponse,
} from "./types.ts";
import { ulid } from "./ulid.ts";

// Re-export DaemonConfig so tests can import from daemon.ts
export type { DaemonConfig } from "./daemon/context.ts";

// Read version from package.json at startup.
const _pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const VERSION = _pkg.version;

// Capture git commit hash once at startup for traceability.
let GIT_HASH = "unknown";
try {
	const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
	if (result.exitCode === 0) {
		GIT_HASH = new TextDecoder().decode(result.stdout).trim();
	}
} catch {
	// git not available or not a git repo — keep "unknown"
}

const startTime = Date.now();

const defaultConfig: DaemonConfig = {
	dataDir: join(homedir(), ".opengraft"),
};

export function createApp(config: DaemonConfig = defaultConfig) {
	const app = new Hono();

	// Build the shared context object
	const ctx: DaemonContext = {
		config,
		pm: new ProjectManager(config.dataDir),
		trackers: new Map(),
		restartingProjects: new Set(),
		sseClients: new Set<SSEClient>(),
		activeSessions: new Map<string, AgentSession>(),
		pendingClarifications: new Map<string, PendingClarification[]>(),
		eventStores: new Map(),
		requestCount: 0,
		startupReady: false,
		globalConfig: config.initialConfig ?? {},
	};

	// Request counter middleware
	app.use("*", async (_c, next) => {
		ctx.requestCount++;
		await next();
	});

	// Auth middleware — must be before all routes
	const authMiddleware = createAuthMiddleware(ctx);
	app.use("*", authMiddleware);

	// Auth routes (login/logout/status + registration on main port)
	// Registration endpoints are guarded per-route: return 403 when enforced
	registerAuthRoutes(app, ctx);

	// Health
	app.get("/health", async (c) => {
		const response: HealthResponse = {
			status: "ok",
			version: VERSION,
			gitHash: GIT_HASH,
			uptime: Date.now() - startTime,
		};

		if (c.req.query("check_model") === "true") {
			const authGroup = resolveAuthGroup(ctx.globalConfig);
			const modelName = ctx.globalConfig.model ?? DEFAULT_MODEL;

			const apiKey = authGroup?.anthropicApiKey;
			const oauthToken = authGroup?.claudeOauthToken;
			const useOAuth = Boolean(oauthToken && !apiKey);

			let client: Anthropic;
			if (useOAuth) {
				client = new Anthropic({
					authToken: oauthToken,
					defaultHeaders: {
						"anthropic-beta": "oauth-2025-04-20",
					},
				});
			} else if (apiKey) {
				client = new Anthropic({ apiKey });
			} else {
				client = new Anthropic();
			}

			const msgParams = {
				model: modelName,
				messages: [{ role: "user" as const, content: "ping" }],
				max_tokens: 10,
				...(useOAuth
					? {
							system: [
								{
									type: "text" as const,
									text: "You are Claude Code, Anthropic's official CLI for Claude.",
								},
							],
						}
					: {}),
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
		const projects = ctx.pm.list();
		const projectCount = projects.length;

		let nodeCount = 0;
		for (const project of projects) {
			const tracker = await getTracker(ctx, project.id);
			nodeCount += tracker.allNodes().length;
		}

		const response: VersionResponse = {
			version: VERSION,
			gitHash: GIT_HASH,
			nodeCount,
			projectCount,
		};
		return c.json(response);
	});

	// Stats
	app.get("/stats", async (c) => {
		const projects = ctx.pm.list();
		const taskCounts = {
			draft: 0,
			pending: 0,
			in_progress: 0,
			passed: 0,
			failed: 0,
			closed: 0,
		};

		for (const project of projects) {
			const tracker = await getTracker(ctx, project.id);
			for (const node of tracker.allNodes()) {
				taskCounts[node.status]++;
			}
		}

		const response: StatsResponse = {
			uptime: Math.floor((Date.now() - startTime) / 1000),
			requestCount: ctx.requestCount,
			projectCount: projects.length,
			taskCounts,
		};
		return c.json(response);
	});

	// Restart daemon
	app.post("/restart-daemon", async (c) => {
		// Respond first, then shutdown
		setTimeout(async () => {
			await shutdown();
			process.exit(0);
		}, 100);
		return c.json({ restarting: true });
	});

	// Register all route groups
	registerProjectRoutes(app, ctx);
	registerTaskRoutes(app, ctx, ORCHESTRATOR_SYSTEM_PROMPT);
	registerConfigRoutes(app, ctx);
	registerAgentRoutes(app, ctx, ORCHESTRATOR_SYSTEM_PROMPT);
	registerSSERoute(app, ctx);

	// Static file serving for the web UI (fallback for non-Bun environments)
	app.use("/web/*", serveStatic({ root: "./" }));

	/** Auto-resume agents that were running before daemon restart.
	 *
	 * Each agent is evaluated independently by its JSONL state:
	 * - Yielding (hasPendingYield) → launch with provider loop bypass (zero API call,
	 *   goes straight to queue.wait). Agent only wakes when a message arrives.
	 * - Interrupted (has orphan non-yield tool_call) → write orphan tool_result, normal resume.
	 * - Done (status passed/failed/closed) → skip, already finished.
	 *
	 * Root and children are resumed independently — no more "mark children failed, resume root".
	 */
	async function autoResumeProjects(): Promise<void> {
		const projects = ctx.pm.list();
		for (const project of projects) {
			const tracker = await getTracker(ctx, project.id);
			const eventStore = getEventStore(ctx, project.id);

			// Collect all in_progress nodes that have JSONL sessions
			const inProgressNodes = tracker
				.allNodes()
				.filter((n) => n.status === "in_progress" && eventStore.has(n.id));

			if (inProgressNodes.length === 0) continue;

			// Phase 1: Write orphan tool_results and bg_complete for ALL nodes.
			// This must happen before any agent is launched.
			for (const node of tracker.allNodes()) {
				await writeOrphanedToolResults(eventStore, node.id);

				// Write synthetic background_complete for bg processes killed by restart.
				// EXCEPT for yielding agents — writing events between yield tool_call
				// and its tool_result breaks the converter → API 400.
				const nodeEvents = eventStore.has(node.id)
					? eventStore.readActive(node.id)
					: [];
				if (!hasPendingYield(nodeEvents)) {
					const bgOrphans = findOrphanedBackgroundProcesses(
						nodeEvents,
						node.id,
					);
					if (bgOrphans.length > 0) {
						await eventStore.appendBatch(node.id, bgOrphans);
					}
				}
			}

			// Phase 2: Classify each in_progress node and resume accordingly.
			const rootNodeId = tracker.rootNodeId;
			for (const node of inProgressNodes) {
				const nodeEvents = eventStore.readActive(node.id);
				const isYielding = hasPendingYield(nodeEvents);
				const isRoot = node.id === rootNodeId;

				if (isRoot) {
					if (isYielding) {
						// Yielding root: launch with provider loop bypass.
						// Provider loop detects pendingYieldToolCall from JSONL and
						// goes straight to queue.wait() — zero API call.
						// No resume message needed — agent will wake when a message arrives
						// (user message, child task_complete, cross-project, etc.)
						console.log(
							`Auto-resuming ${project.name} root (yielding — bypass to queue.wait)`,
						);
						await launchAgent(
							ctx,
							project,
							{ resume: true },
							ORCHESTRATOR_SYSTEM_PROMPT,
						);
					} else {
						// Interrupted root: normal resume with context message.
						console.log(
							`Auto-resuming ${project.name} root (interrupted — normal resume)`,
						);
						const resumeMemory = readProjectMemory(project.path);
						const resumeHeader = resumeMemory
							? `Working directory: ${project.path}\n\n# .opengraft/memory.md (Preloaded, do not read again)\n${resumeMemory}`
							: `Working directory: ${project.path}`;
						await persistMessage(ctx.config.dataDir, project.id, rootNodeId, {
							source: "user",
							id: ulid(), ts: Date.now(),
							content: `Continue where you left off. The daemon restarted (${GIT_HASH}).\n\nCheck the task tree and proceed.`,
							header: resumeHeader,
						});
						await launchAgent(
							ctx,
							project,
							{ resume: true },
							ORCHESTRATOR_SYSTEM_PROMPT,
						);
					}
				} else {
					// Child agent: resume via runChildAgentInBackground.
					// It handles its own orphan cleanup, event loading, and resume detection.
					// Yielding children: provider loop detects pendingYieldToolCall from JSONL.
					if (node.worktreePath) {
						console.log(
							`Auto-resuming ${project.name} child ${node.id.slice(0, 8)} (${isYielding ? "yielding" : "interrupted"})`,
						);
						runChildAgentInBackground(ctx, project, tracker, node.id).catch(
							(e) => {
								console.error(
									`[autoResume] Failed to resume child ${node.id}:`,
									e,
								);
							},
						);
					}
				}
			}
		}
	}

	/** Graceful shutdown: stop all agents. */
	async function shutdown(): Promise<void> {
		// Stop all agents — their root nodes stay in_progress so they resume on next start
		const projectIds = [...ctx.activeSessions.keys()];
		for (const projectId of projectIds) {
			await stopAgent(ctx, projectId);
		}
	}

	function markReady() {
		ctx.startupReady = true;
	}

	async function loadConfig() {
		ctx.globalConfig = await loadGlobalConfig(ctx.config.globalConfigPath);
	}

	return {
		app,
		pm: ctx.pm,
		dataDir: config.dataDir,
		sseClients: ctx.sseClients,
		activeSessions: ctx.activeSessions,
		autoResumeProjects,
		shutdown,
		getTracker: (projectId: string) => getTracker(ctx, projectId),
		markReady,
		loadConfig,
		getConfig: () => ctx.globalConfig,
	};
}

const ORCHESTRATOR_SYSTEM_PROMPT = buildSystemPrompt();

// Only start the server when run directly, not when imported for testing.
if (import.meta.main) {
	const {
		app,
		pm,
		autoResumeProjects,
		shutdown,
		markReady,
		loadConfig,
		getConfig,
	} = createApp();
	await pm.load();
	await loadConfig();

	const port = getConfig().port ?? 7433;

	// Check if another daemon is already running on this port
	try {
		const res = await fetch(`http://localhost:${port}/health`);
		if (res.ok) {
			console.error(`Error: OpenGraft daemon already running on port ${port}`);
			process.exit(1);
		}
	} catch {
		// Port is free, proceed
	}
	console.log(
		`OpenGraft daemon v${VERSION} (${GIT_HASH}) listening on http://localhost:${port}`,
	);
	console.log(`Web UI: http://localhost:${port}/`);

	// Use Bun's HTML import for the web UI (auto-bundles TSX/CSS)
	const webIndex = await import("../web/index.html");
	Bun.serve({
		routes: {
			"/": webIndex.default,
		},
		fetch: app.fetch,
		port,
		idleTimeout: 255, // Bun max (4.25 min) — data heartbeat at 15s keeps it alive
		development:
			process.env.NODE_ENV === "development"
				? { hmr: true, console: true }
				: false,
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
