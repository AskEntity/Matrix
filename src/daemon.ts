import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { serveStatic, websocket } from "hono/bun";
import { ADMIN_REGISTRATION_PAGE } from "./admin-page.ts";
import type { AgentSession } from "./agent-provider.ts";
import { ORCHESTRATION_KNOWLEDGE } from "./agent-tools.ts";
import { DEFAULT_MODEL, loadGlobalConfig, resolveAuthGroup } from "./config.ts";
import { launchAgent, stopAgent } from "./daemon/agent-lifecycle.ts";
import type {
	DaemonConfig,
	DaemonContext,
	PendingClarification,
	PendingMessage,
	WSClient,
} from "./daemon/context.ts";
import { flushEvents, loadEventHistory } from "./daemon/event-system.ts";
import { getTracker, pruneSessionFiles } from "./daemon/helpers.ts";
import { registerAgentRoutes } from "./daemon/routes/agent.ts";
import {
	createAuthMiddleware,
	registerAdminAuthRoutes,
	registerAuthRoutes,
} from "./daemon/routes/auth.ts";
import { registerConfigRoutes } from "./daemon/routes/config.ts";
import { registerProjectRoutes } from "./daemon/routes/projects.ts";
import { registerTaskRoutes } from "./daemon/routes/tasks.ts";
import { registerWebSocketRoute } from "./daemon/routes/websocket.ts";
import { ProjectManager } from "./project-manager.ts";
import type {
	HealthResponse,
	StatsResponse,
	VersionResponse,
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
		wsClients: new Set<WSClient>(),
		activeSessions: new Map<string, AgentSession>(),
		eventHistory: new Map<string, Record<string, unknown>[]>(),
		eventsDirty: new Set<string>(),
		pendingMessages: new Map<string, PendingMessage[]>(),
		pendingClarifications: new Map<string, PendingClarification[]>(),
		sessionStores: new Map(),
		MAX_EVENT_HISTORY: 5000,
		requestCount: 0,
		startupReady: false,
		globalConfig: config.initialConfig ?? {},
		eventFlushTimer: null,
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
			testing: 0,
			passed: 0,
			failed: 0,
			stuck: 0,
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
	registerTaskRoutes(app, ctx);
	registerConfigRoutes(app, ctx);
	registerAgentRoutes(app, ctx, ORCHESTRATOR_SYSTEM_PROMPT);
	registerWebSocketRoute(app, ctx, ORCHESTRATOR_SYSTEM_PROMPT);

	// Static file serving for the web UI (fallback for non-Bun environments)
	app.use("/web/*", serveStatic({ root: "./" }));

	/** Auto-resume orchestrations that were running before daemon restart. */
	async function autoResumeProjects(): Promise<void> {
		const sessionKeep = ctx.globalConfig.sessionKeep ?? 5;
		const projects = ctx.pm.list();
		for (const project of projects) {
			// Auto-prune old session files to prevent unbounded disk growth
			const result = await pruneSessionFiles(ctx, project.id, sessionKeep);
			if (result.pruned > 0) {
				console.log(
					`Auto-pruned ${result.pruned} old session(s) for ${project.name}`,
				);
			}

			const tracker = await getTracker(ctx, project.id);
			const rootNode = tracker.rootNodeId
				? tracker.get(tracker.rootNodeId)
				: null;
			if (rootNode && rootNode.status === "in_progress") {
				// Reset orphaned in_progress tasks — their agent sessions died with the daemon
				// Skip the root node — it will be re-activated by launchAgent
				let orphanCount = 0;
				for (const node of tracker.allNodes()) {
					if (node.status === "in_progress" && node.id !== tracker.rootNodeId) {
						tracker.updateStatus(node.id, "failed");
						orphanCount++;
					}
				}
				if (orphanCount > 0) await tracker.save();

				// Load event history from disk so UI can show previous logs
				const events = await loadEventHistory(ctx, project.id);

				// Extract recent error events so the agent knows what went wrong
				const errorMessages = events
					.filter(
						(e) =>
							e.type === "error" ||
							(e.type === "agent_event" && e.eventType === "error"),
					)
					.slice(-5)
					.map((e) => String(e.message ?? "Unknown error"));

				console.log(
					`Auto-resuming orchestration for ${project.name} (${project.id.slice(0, 8)})`,
				);
				const errorSection =
					errorMessages.length > 0
						? `\n\nPrevious session encountered these errors:\n${errorMessages.map((m) => `- ${m}`).join("\n")}`
						: "";
				const resumePrompt = `Continue where you left off. The daemon restarted.${orphanCount > 0 ? ` Note: ${orphanCount} in_progress task(s) were reset to failed.` : ""}${errorSection}\n\nCheck the task tree and proceed.`;
				// Clear error events after injecting them into resume prompt — show once only
				if (errorMessages.length > 0) {
					const cleaned = events.filter(
						(e) =>
							e.type !== "error" &&
							!(e.type === "agent_event" && e.eventType === "error"),
					);
					ctx.eventHistory.set(project.id, cleaned);
					ctx.eventsDirty.add(project.id);
				}
				await launchAgent(
					ctx,
					project,
					{
						prompt: resumePrompt,
						resume: true,
					},
					ORCHESTRATOR_SYSTEM_PROMPT,
				);
			}
		}
	}

	/** Graceful shutdown: save all active session IDs and flush events. */
	async function shutdown(): Promise<void> {
		// Stop all agents — their root nodes stay in_progress so they resume on next start
		const projectIds = [...ctx.activeSessions.keys()];
		for (const projectId of projectIds) {
			await stopAgent(ctx, projectId);
		}
		await flushEvents(ctx);
	}

	function markReady() {
		ctx.startupReady = true;
	}

	async function loadConfig() {
		ctx.globalConfig = await loadGlobalConfig(ctx.config.globalConfigPath);
	}

	// Build admin app for passkey registration (localhost-only)
	const adminApp = new Hono();
	adminApp.get("/health", (c) => c.json({ status: "ok", admin: true }));
	registerAdminAuthRoutes(adminApp, ctx);
	// Serve a simple registration page
	adminApp.get("/", (c) => {
		return c.html(ADMIN_REGISTRATION_PAGE);
	});

	return {
		app,
		adminApp,
		pm: ctx.pm,
		wsClients: ctx.wsClients,
		activeSessions: ctx.activeSessions,
		autoResumeProjects,
		shutdown,
		getTracker: (projectId: string) => getTracker(ctx, projectId),
		markReady,
		loadConfig,
		getConfig: () => ctx.globalConfig,
	};
}

const ORCHESTRATOR_SYSTEM_PROMPT = `Today's date is ${new Date().toISOString().split("T")[0]}.

You are the top-level orchestrator for this project.
You ONLY manage tasks — you NEVER write code yourself, not even "simple" fixes.
All implementation is done by child agents in isolated worktrees.
Exception: you MAY use edit_file to resolve merge conflicts — this is task management, not implementation.

## Built-in Tools
You have these tools for exploring the codebase and managing merges:
- read_file: Read file contents (use this instead of bash cat)
- search: Regex search across files (use this instead of bash grep/rg)
- list_files: Glob pattern matching (use this instead of bash find/ls)
- edit_file: Edit files (for merge conflict resolution only)
- bash: Shell commands (for git, tests, build tools — NOT for reading files)
  Working directory is automatically tracked across calls — if you \`cd\` in one command,
  subsequent commands run from the new directory. Do NOT prefix every command with \`cd /path &&\`.

Do NOT use bash to read files (cat, head, tail) or search (grep, rg). Use the dedicated tools.

## First Steps (every session)
1. Read \`.opengraft/memory.md\` — contains project knowledge, pitfalls, conventions
2. Read \`CLAUDE.md\` if it exists — contains project-specific instructions
3. If this is a new/unfamiliar project, explore before acting:
   - \`list_files("*")\` to understand top-level structure
   - Read package.json, README, or equivalent to understand the tech stack
   - \`list_files("src/**/*.ts")\` (or equivalent) to understand code organization
   - Identify test patterns, build commands, and project conventions
4. Only then: analyze the user's goal, decompose into tasks, and execute

## Your Role
- When the user provides an explicit instruction, suggestion, or request, execute it directly as stated. Do not reinterpret, rephrase, or second-guess explicit instructions.
- Analyze goals, decompose into tasks, spawn child agents, merge results
- Read project docs (\`.opengraft/memory.md\`, \`CLAUDE.md\`) to understand context
- Update \`.opengraft/memory.md\` with important decisions and discoveries
- After merging all children, run full test suite to verify integration
- When everything is done and verified, call done("passed", summary) to report completion

## Orchestration Philosophy
- **Always create tasks** — don't use "wait for previous task" as an excuse to not create one. Task descriptions can be updated later. Parallel by default. Most tasks have independent scopes.
- **Parallel by default** — sibling tasks run in parallel. Only serialize when truly dependent (e.g. "types first, then implementation").
- **Only skip creating** when a task is so heavily dependent that even scoping is impossible (extremely rare). Conflicts are normal and expected — git merges resolve them.
- **Prefer deep trees** over flat lists — each level multiplies parallelism.
- **Draft every idea** — when the user mentions ANY idea, bug, or feature (even half-formed), immediately create a draft task (\`draft: true\`). Drafts get status="draft" and can't be executed until promoted. Drafts are cheap, lost context is expensive. Don't wait for "create a task" — if it's worth doing, draft it now.

## Maximize Parallelism
The task tree is a TREE, not a flat list. Decompose work to maximize parallel execution:
- Split into independent subtasks that can run simultaneously on separate branches
- Each level of the tree multiplies parallelism — prefer deep parallel trees over shallow sequential lists
- A child that receives a complex task should further decompose it into its own children
- Only serialize tasks that truly depend on each other (e.g., "types first, then implementation")

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

## Multi-Phase Tasks
When a task has multiple phases (e.g., "Phase 1: types, Phase 2: implementation, Phase 3: tests"):
- Create ALL phase sub-tasks upfront under the parent task, not just the current phase
- Execute phases in order (or parallel where possible)
- Keep the parent task open (pending/in_progress) until ALL phases are complete
- Only close the parent when every phase is done
- Each phase's completion status is independent — a phase can be closed while the parent stays open

## Review Before Merge
After a child passes and before merging:
- Read the child's completion summary and any child_report messages carefully
- After merging, run the test suite to verify integration
- If the merged code introduces issues, either fix via a new task or reset

## Stopping
Call done("passed", summary) when all tasks are resolved (all passed/merged) and verified.
Call done("failed", summary) if you're blocked and cannot make progress.
Never stop just because you finished responding — check get_tree and keep driving.

${ORCHESTRATION_KNOWLEDGE}`;

// Only start the server when run directly, not when imported for testing.
if (import.meta.main) {
	const {
		app,
		adminApp,
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
		websocket,
		development:
			process.env.NODE_ENV === "development"
				? { hmr: true, console: true }
				: false,
	});

	// Admin server for passkey management (always runs, localhost-only)
	{
		const adminPort = getConfig().auth?.adminPort ?? 7434;
		Bun.serve({
			fetch: adminApp.fetch,
			port: adminPort,
			hostname: "127.0.0.1", // localhost only
		});
		console.log(
			`Admin server (passkey registration): http://localhost:${adminPort}`,
		);
	}

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
