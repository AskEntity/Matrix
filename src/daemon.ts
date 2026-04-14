import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import {
	DEFAULT_CONFIG,
	DEFAULT_MODEL,
	loadGlobalConfig,
	resolveAuthGroup,
} from "./config.ts";
import {
	buildMatrixScopeOpts,
	deliverMessage,
	runAgentForNode,
	stopAgent,
} from "./daemon/agent-lifecycle.ts";
import type {
	DaemonConfig,
	DaemonContext,
	PendingClarification,
	SSEClient,
} from "./daemon/context.ts";
import { broadcastTreeUpdate, emitEvent } from "./daemon/event-system.ts";
import { getEventStore, getTracker } from "./daemon/helpers.ts";
import { registerAgentRoutes } from "./daemon/routes/agent.ts";
import {
	createAuthMiddleware,
	registerAuthRoutes,
} from "./daemon/routes/auth.ts";
import { registerConfigRoutes } from "./daemon/routes/config.ts";
import { registerMcpEndpoint } from "./daemon/routes/mcp-endpoint.ts";
import { registerMockShowcaseRoute } from "./daemon/routes/mock-showcase.ts";
import { registerProjectRoutes } from "./daemon/routes/projects.ts";
import { registerSSERoute } from "./daemon/routes/sse.ts";
import { registerTaskRoutes } from "./daemon/routes/tasks.ts";

import type { Event } from "./events.ts";
import { ProjectManager } from "./project-manager.ts";
import { createTaskComplete } from "./queue-message-factory.ts";

// buildSystemPrompt import removed — prompt is now provided by buildMatrixScopeOpts
import { TOOL_DONE } from "./tool-names.ts";
import {
	type HealthResponse,
	isTask,
	type StatsResponse,
	type VersionResponse,
} from "./types.ts";

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
	dataDir: join(homedir(), ".mxd"),
};

/**
 * Detect interrupted Phase 2 of two-phase done() from JSONL events.
 *
 * Returns null if no recovery needed.
 * Returns { type: "needs_phase2", status, summary } if done tool_call exists without done_notified.
 * Returns { type: "status_stale", status } if done_notified exists but node status wasn't saved.
 */
export function findInterruptedDonePhase2(events: Event[]):
	| {
			type: "needs_phase2";
			status: "verify" | "failed";
			summary: string;
	  }
	| {
			type: "status_stale";
			status: "verify" | "failed";
	  }
	| null {
	// Find the last done tool_call (orphan — no tool_result follows it)
	let lastDoneCall: (Event & { type: "tool_call" }) | null = null;
	let lastDoneCallTs = 0;
	const toolResultIds = new Set<string>();

	for (const e of events) {
		if (e.type === "tool_call" && e.tool === TOOL_DONE) {
			lastDoneCall = e as Event & { type: "tool_call" };
			lastDoneCallTs = e.ts;
		}
		if (e.type === "tool_result") {
			toolResultIds.add(e.toolCallId);
		}
	}

	if (!lastDoneCall) return null;

	// If the done tool_call has a tool_result, it was a resumed done (not an orphan).
	// The agent already processed it. No crash recovery needed.
	if (toolResultIds.has(lastDoneCall.toolCallId)) return null;

	// Check for done_notified after the done tool_call
	const hasDoneNotified = events.some(
		(e) => e.type === "done_notified" && e.ts >= lastDoneCallTs,
	);

	const doneInput = lastDoneCall.input as
		| { status?: string; summary?: string }
		| undefined;
	const status =
		doneInput?.status === "passed" ? ("verify" as const) : ("failed" as const);
	const summary = doneInput?.summary ?? "";

	if (!hasDoneNotified) {
		// Phase 2 never completed — need to run it now
		return { type: "needs_phase2", status, summary };
	}

	// done_notified exists — check if the node still has stale status.
	// The caller checks node.status === "in_progress" to decide if status_stale applies.
	return { type: "status_stale", status };
}

export function createApp(config: DaemonConfig = defaultConfig) {
	const app = new Hono();

	// Build the shared context object
	const ctx: DaemonContext = {
		config,
		pm: new ProjectManager(config.dataDir),
		trackers: new Map(),
		restartingProjects: new Set(),
		launchingNodes: new Set(),
		sseClients: new Set<SSEClient>(),
		eventSubscribers: new Map(),
		pendingClarifications: new Map<string, PendingClarification[]>(),
		eventStores: new Map(),
		streamingText: new Map(),
		agentLoopPromises: new Map(),
		scopeOpts: new Map(),
		requestCount: 0,
		startupReady: false,
		// Defensive clone: DEFAULT_CONFIG is frozen, and even if initialConfig is
		// provided we don't want mutations leaking back to the caller's object.
		globalConfig: { ...(config.initialConfig ?? DEFAULT_CONFIG) },
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

			const apiKey =
				authGroup?.provider === "anthropic" ? authGroup.apiKey : undefined;
			const oauthToken =
				authGroup?.provider === "anthropic" ? authGroup.oauthToken : undefined;
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

			const preamble =
				authGroup?.provider === "anthropic"
					? authGroup.systemPreamble
					: undefined;
			const msgParams = {
				model: modelName,
				messages: [{ role: "user" as const, content: "ping" }],
				max_tokens: 10,
				...(preamble
					? {
							system: [{ type: "text" as const, text: preamble }],
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
			verify: 0,
			failed: 0,
			closed: 0,
		};

		for (const project of projects) {
			const tracker = await getTracker(ctx, project.id);
			for (const node of tracker.allNodes()) {
				if (isTask(node)) taskCounts[node.status]++;
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
	registerTaskRoutes(app, ctx);
	registerConfigRoutes(app, ctx);
	registerAgentRoutes(app, ctx);
	registerSSERoute(app, ctx);
	registerMcpEndpoint(app, ctx);
	registerMockShowcaseRoute(app);

	// Static file serving for the web UI (fallback for non-Bun environments)
	app.use("/web/*", serveStatic({ root: "./" }));

	/** Auto-resume agents that were running before daemon restart.
	 *
	 * Simply finds all in_progress nodes with JSONL sessions and launches them
	 * via runAgentForNode. No resume messages, no root/child split, no
	 * yielding/interrupted distinction.
	 *
	 * The three resume states handle themselves inside the provider loop:
	 * - Explicit yield (JSONL ends with yield tool_call): pendingYieldToolCall
	 *   bypasses initial drain → queue.wait → zero API call until message arrives
	 * - Implicit yield (JSONL ends with assistant_text): pendingImplicitYieldResume
	 *   bypasses initial drain → handleImplicitYield → zero API call until message
	 * - Interrupted (JSONL has orphaned tool_calls): buildSessionRepair adds
	 *   tool_results → messages end with user content → skip initial drain → API call
	 */
	/**
	 * Resume a single project scope: crash recovery + launch in_progress agents.
	 * Extracted so plugin scopes can reuse the same startup logic.
	 */
	async function resumeScope(
		project: { id: string; name: string; path: string },
		tracker: import("./task-tracker.ts").TaskTracker,
		eventStore: import("./event-store.ts").EventStore,
		scopeOpts: import("./daemon/context.ts").ScopeOpts,
	): Promise<void> {
		const shouldResumeFn = scopeOpts.shouldResume ?? ((n: import("./types.ts").TaskNode) => n.status === "in_progress");

		// ── Phase 2 crash recovery ──
		const allNodes = tracker.allNodes();
		for (const node of allNodes) {
			if (!isTask(node)) continue;
			if (!eventStore.has(node.id)) continue;

			await eventStore.flushSession(node.id);
			const events = eventStore.readActive(node.id);

			const crashRecovery = findInterruptedDonePhase2(events);
			if (!crashRecovery) continue;

			if (crashRecovery.type === "needs_phase2") {
				const { status, summary } = crashRecovery;
				console.log(
					`[autoResume] Completing interrupted Phase 2 for ${node.id} (status=${status})`,
				);
				tracker.updateStatus(node.id, status);

				const isRoot = node.id === tracker.rootNodeId;
				const taskAbove = tracker.getTaskAbove(node.id);
				if (taskAbove && !isRoot) {
					const completionMsg = createTaskComplete(
						node.id,
						node.title ?? "unknown",
						status === "verify",
						summary,
					);
					await deliverMessage(
						ctx,
						project,
						taskAbove.id,
						completionMsg,
						{ quiet: true },
					).catch((e) => {
						console.warn(
							`[autoResume] Failed to deliver task_complete to parent ${taskAbove.id}:`,
							e,
						);
					});
				}

				emitEvent(ctx, project.id, {
					type: "done_notified",
					taskId: node.id,
					doneData: { status, summary },
					ts: Date.now(),
				});
				await eventStore.flushSession(node.id);
				await tracker.save();
				broadcastTreeUpdate(ctx, project.id, tracker);
			} else if (
				crashRecovery.type === "status_stale" &&
				shouldResumeFn(node)
			) {
				// Node should have been updated to done status but crashed before save.
				// Apply the done status from JSONL's done_notified event.
				const { status } = crashRecovery;
				console.log(
					`[autoResume] Fixing stale status for ${node.id} (→${status})`,
				);
				tracker.updateStatus(node.id, status);
				await tracker.save();
				broadcastTreeUpdate(ctx, project.id, tracker);
			}
		}

		// ── Launch agents that should be active ──
		const resumableNodes = tracker
			.allNodes()
			.filter(
				(n): n is import("./types.ts").TaskNode =>
					isTask(n) && shouldResumeFn(n) && eventStore.has(n.id),
			);

		for (const node of resumableNodes) {

			console.log(`Auto-resuming ${project.name} node ${node.id}`);

			runAgentForNode(ctx, project, tracker, node.id, {
				...scopeOpts,
				resume: true,
			}).catch((e) => {
				console.error(
					`[autoResume] Failed to resume ${node.id}:`,
					e instanceof Error ? e.message : e,
				);
			});
		}
	}

	async function autoResumeProjects(): Promise<void> {
		const projects = ctx.pm.list();
		for (const project of projects) {
			const tracker = await getTracker(ctx, project.id);
			const eventStore = getEventStore(ctx, project.id);
			const matrixOpts = buildMatrixScopeOpts(
				project.id,
				ctx.globalConfig.selfBootstrap,
				ctx,
			);
			// Register scope opts so internal paths (deliverMessage, ensureChildAgentRunning)
			// can look up the project's tools + prompt without passing them through every call.
			ctx.scopeOpts.set(project.id, matrixOpts);
			await resumeScope(project, tracker, eventStore, matrixOpts);
		}
	}

	/** Graceful shutdown: stop all agents, await loop settlement for JSONL persistence. */
	async function shutdown(): Promise<void> {
		// Stop all agents — their root nodes stay in_progress so they resume on next start
		for (const [projectId, tracker] of ctx.trackers) {
			const rootNode = tracker.getTask(tracker.rootNodeId);
			if (rootNode?.session) {
				await stopAgent(ctx, projectId);
			}
		}
		// stopAgent emits agent_end synchronously — no need to await loop promises.
	}

	function markReady() {
		ctx.startupReady = true;
	}

	async function loadConfig() {
		ctx.globalConfig = await loadGlobalConfig(ctx.config.globalConfigPath);
	}

	return {
		app,
		ctx,
		pm: ctx.pm,
		dataDir: config.dataDir,
		sseClients: ctx.sseClients,
		autoResumeProjects,
		shutdown,
		getTracker: (projectId: string) => getTracker(ctx, projectId),
		markReady,
		loadConfig,
		getConfig: () => ctx.globalConfig,
	};
}

// ORCHESTRATOR_SYSTEM_PROMPT removed — prompt is now provided by buildMatrixScopeOpts
// and stored in ctx.scopeOpts per project.

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
			console.error(`Error: Matrix daemon already running on port ${port}`);
			process.exit(1);
		}
	} catch {
		// Port is free, proceed
	}
	console.log(
		`Matrix daemon v${VERSION} (${GIT_HASH}) listening on http://localhost:${port}`,
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
