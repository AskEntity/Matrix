import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import {
	DEFAULT_CONFIG,
	loadGlobalConfig,
	resolveAnthropicBaseUrl,
	resolveAuthGroup,
} from "./config.ts";
import {
	doneCompletionOutput,
	type Event,
	shouldLaunchAgent,
} from "./events.ts";
import { ProjectStore } from "./project-store.ts";
import { createTaskComplete } from "./queue-message-factory.ts";
import {
	deliverMessage,
	runAgentForNode,
	stopAgent,
} from "./runtime/agent-lifecycle.ts";
import type {
	PendingClarification,
	RuntimeConfig,
	RuntimeContext,
} from "./runtime/context.ts";
import { broadcastTreeUpdate, emitEvent } from "./runtime/event-system.ts";
import { getEventStore, getTracker } from "./runtime/helpers.ts";
import { registerAgentRoutes } from "./runtime/routes/agent.ts";
// Auth handled by daemon shell — runtime has no auth.
// Config routes handled by daemon shell — worker has no config CRUD.
import { registerMcpEndpoint } from "./runtime/routes/mcp-endpoint.ts";
import { registerProjectRoutes } from "./runtime/routes/projects.ts";
import { registerTaskRoutes } from "./runtime/routes/tasks.ts";

import { TOOL_DONE } from "./tool-names.ts";
import {
	type HealthResponse,
	isTask,
	type StatsResponse,
	type VersionResponse,
} from "./types.ts";

// Re-export RuntimeConfig so tests can import from runtime.ts.
export type { RuntimeConfig } from "./runtime/context.ts";

import { GIT_HASH, VERSION } from "./version.ts";

const startTime = Date.now();

const defaultConfig: RuntimeConfig = {
	dataDir: join(homedir(), ".mxd"),
};

/**
 * Detect interrupted Phase 2 of two-phase done() from JSONL events.
 *
 * Returns null if no recovery needed.
 * Returns { type: "needs_phase2", status, result } if done tool_call exists without done_notified.
 * Returns { type: "status_stale", status } if done_notified exists but node status wasn't saved.
 */
export function findInterruptedDonePhase2(events: Event[]):
	| {
			type: "needs_phase2";
			status: "verify" | "failed";
			result: string;
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

	const doneInput = lastDoneCall.input as { status?: string } | undefined;
	// status is the runtime control bit (routes verify/failed); `result` is the
	// universal completion-output string (parent notice), read from the SAME done
	// tool_call so a crash-recovered done carries the exact string the live path
	// would have delivered. Crash recovery is plugin-agnostic: it never reads
	// round content and can't append a resultRound.
	const status =
		doneInput?.status === "passed" ? ("verify" as const) : ("failed" as const);
	const result = doneCompletionOutput(lastDoneCall.input);

	if (!hasDoneNotified) {
		// Phase 2 never completed — need to run it now
		return { type: "needs_phase2", status, result };
	}

	// done_notified exists — check if the node still has stale status.
	// The caller checks node.status === "in_progress" to decide if status_stale applies.
	return { type: "status_stale", status };
}

export function createApp(config: RuntimeConfig = defaultConfig) {
	const app = new Hono();

	// Build the shared context object
	const ctx: RuntimeContext = {
		config,
		pm: (() => {
			const store = new ProjectStore();
			if (config.projects) store.sync(config.projects);
			return store;
		})(),
		trackers: new Map(),
		restartingProjects: new Set(),
		launchingNodes: new Set(),
		eventSubscribers: new Map(),
		pendingClarifications: new Map<string, PendingClarification[]>(),
		eventStores: new Map(),
		streamingText: new Map(),
		streamingThinking: new Map(),
		agentLoopPromises: new Map(),
		scopeOpts: new Map(),
		requestCount: 0,
		startupReady: false,
		// Defensive clone: DEFAULT_CONFIG is frozen, and even if initialConfig is
		// provided we don't want mutations leaking back to the caller's object.
		globalConfig: { ...(config.initialConfig ?? DEFAULT_CONFIG) },
		// Forward globalContext from config for convenient runtime/plugin access.
		globalContext: config.globalContext,
	};

	// NOTE: tasks/ and debug/ directories are NOT eagerly created here.
	// EventStore's constructor and TaskTracker.save() mkdir on demand,
	// respecting the worker's dataRoot. Pre-creating them hardcoded
	// Matrix's "@" layout and would produce stale empty dirs at the wrong
	// location for any plugin with a nested dataRoot.

	/**
	 * Get ScopeOpts for a project from the injected plugin builder.
	 * No fallback — caller MUST provide buildScopeOpts in RuntimeConfig.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: ScopeOpts generic varies by plugin
	function getScopeOptsForProject(
		projectId: string,
	): import("./runtime/context.ts").ScopeOpts<any> {
		if (!config.buildScopeOpts) {
			throw new Error(
				"buildScopeOpts not provided in RuntimeConfig. " +
					"Runtime is plugin-agnostic — the caller must inject scope opts.",
			);
		}
		return config.buildScopeOpts(projectId, ctx);
	}

	// Request counter middleware
	app.use("*", async (_c, next) => {
		ctx.requestCount++;
		await next();
	});

	// Auth is handled by daemon (shell layer). Runtime runs in worker — no auth needed.

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
			const modelName = ctx.globalConfig.model;

			const apiKey =
				authGroup?.provider === "anthropic" ? authGroup.apiKey : undefined;
			const oauthToken =
				authGroup?.provider === "anthropic" ? authGroup.oauthToken : undefined;
			const useOAuth = Boolean(oauthToken && !apiKey);
			// Always explicit — an omitted `baseURL` is read from ANTHROPIC_BASE_URL
			// by the SDK, so this button would check a host the environment picked.
			// See resolveAnthropicBaseUrl for the decision.
			const baseURL = resolveAnthropicBaseUrl(
				authGroup?.provider === "anthropic" ? authGroup.baseUrl : undefined,
			);

			// ⚠️ Every credential slot named in every branch, unused one `null`. The
			// third of the three sites that hand-build an Anthropic client, and the
			// one where getting this wrong hurts most: this handler backs the
			// Settings "check model" button, which is what a user reaches for while
			// diagnosing exactly this failure. An `undefined` slot is read from env
			// by the SDK, and a client holding both credentials sends both
			// `x-api-key` and `authorization`, which the API rejects — so a shell
			// key used to make this button report that the configured OAuth token
			// was bad. See anthropic-compatible-provider.ts's constructor.
			let client: Anthropic;
			if (useOAuth) {
				client = new Anthropic({
					authToken: oauthToken,
					apiKey: null,
					baseURL,
					defaultHeaders: {
						"anthropic-beta": "oauth-2025-04-20",
					},
				});
			} else if (apiKey) {
				client = new Anthropic({
					apiKey,
					authToken: null,
					baseURL,
				});
			} else {
				// Nothing configured: the check reports an error naming the missing
				// credential, rather than silently testing the shell's.
				client = new Anthropic({
					apiKey: null,
					authToken: null,
					baseURL,
				});
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

	// restart-daemon is daemon-owned (needs process.exit on the main thread)

	// Project list served by daemon. Worker has it for internal routes that need project lookup.

	// Plugin-registered routes run FIRST so plugin middleware (guards, etc.)
	// can intercept matching routes before built-in handlers see them.
	// The plugin contract: export `registerRoutes(app, ctx)` from the plugin
	// runtime module. Plugin owns its own endpoints and guards.
	if (config.registerPluginRoutes) {
		config.registerPluginRoutes(app, ctx);
	}

	// Register all route groups
	registerProjectRoutes(app, ctx);
	registerTaskRoutes(app, ctx);
	// Config routes removed — daemon shell owns config CRUD.
	registerAgentRoutes(app, ctx);
	registerMcpEndpoint(app, ctx);

	/**
	 * Resume a single project's in_progress agents: crash recovery +
	 * relaunch via runAgentForNode. Factored out of autoResumeProjects so
	 * project-lifecycle code (register, re-sync) can reuse it.
	 */
	async function resumeScope(
		project: { id: string; name: string; path: string },
		tracker: import("./task-tracker.ts").TaskTracker,
		eventStore: import("./event-store.ts").EventStore,
		// biome-ignore lint/suspicious/noExplicitAny: erased generic
		scopeOpts: import("./runtime/context.ts").ScopeOpts<any>,
	): Promise<void> {
		const shouldResumeFn =
			scopeOpts.shouldResume ??
			// `status` lives on BaseTaskNode (runtime-generic) — the default
			// resume rule is node-agnostic, not matrix-specific.
			((n: import("./types.ts").BaseTaskNode) => n.status === "in_progress");

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
				const { status, result } = crashRecovery;
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
						result,
					);
					await deliverMessage(ctx, project, taskAbove.id, completionMsg, {
						quiet: true,
					}).catch((e) => {
						console.warn(
							`[autoResume] Failed to deliver task_complete to parent ${taskAbove.id}:`,
							e,
						);
					});
				}

				emitEvent(ctx, project.id, {
					type: "done_notified",
					taskId: node.id,
					status,
					result,
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

		let skipped = 0;
		for (const node of resumableNodes) {
			// Ask the log whether launching will DO anything, before paying for
			// a session. `runAgentForNode` connects MCP servers, builds work
			// context and writes session_config before it ever reads the
			// conversation — measured 2026-07-25 at 4 MCP subprocesses and
			// ~202 MB per session, held for as long as the session lives, and
			// these sessions never end. An agent that will only park must be
			// refused here; there is nowhere later that is cheap.
			//
			// `shouldResumeFn` (status) and this are different questions:
			// status says the node was never finished, this says whether
			// anything is outstanding. Today's dormant nodes have been
			// in_progress for six weeks with nothing owed.
			await eventStore.flushSession(node.id);
			if (!shouldLaunchAgent(eventStore.readActive(node.id))) {
				skipped++;
				continue;
			}

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
		if (skipped > 0) {
			// Said out loud, with both numbers: a silent skip is
			// indistinguishable from a resume that failed, and this decision is
			// the kind whose failure mode is "my agent didn't come back".
			console.log(
				`[autoResume] ${project.name}: launched ${resumableNodes.length - skipped}/${resumableNodes.length} resumable nodes — ${skipped} had no outstanding work`,
			);
		}
	}

	/**
	 * Auto-resume agents that were running before daemon restart.
	 *
	 * Finds all in_progress nodes with JSONL sessions and launches the ones
	 * that have outstanding work, via runAgentForNode. No resume messages, no
	 * root/child split.
	 *
	 * ⚠️ **Status is the filter, not the decision.** `shouldResumeFn` says the
	 * node was never finished; `shouldLaunchAgent` says whether launching will
	 * produce an action. They are different questions and the second is the
	 * expensive one to get wrong — a node that resumes only to park still pays
	 * for MCP connections and a work-context build that live as long as the
	 * session, and a parked session never ends.
	 *
	 * The resume states still handle themselves inside the provider loop; what
	 * changed is that the two which resume to a park are no longer launched at
	 * all:
	 * - Explicit yield (JSONL ends with yield tool_call): would bypass the
	 *   initial drain → queue.wait → zero API call. NOT LAUNCHED.
	 * - Implicit yield (JSONL ends with assistant_text): would bypass to
	 *   handleImplicitYield → zero API call. NOT LAUNCHED.
	 * - Interrupted (orphaned tool_calls, or a consumed message with no
	 *   answer): buildSessionRepair resolves it, messages end with user
	 *   content, the loop skips the drain and calls the API. LAUNCHED.
	 * - Pending input: any unconsumed message wakes the loop. LAUNCHED —
	 *   unless the only thing waiting is an `interrupt` notice, which says the
	 *   user stopped this session deliberately.
	 */
	async function autoResumeProjects(): Promise<void> {
		if (!config.buildScopeOpts) {
			// No plugin runtime → no agent lifecycle. Worker serves routes only.
			return;
		}
		const projects = ctx.pm.list();
		for (const project of projects) {
			const tracker = await getTracker(ctx, project.id);
			const eventStore = getEventStore(ctx, project.id);
			const scopeOpts = getScopeOptsForProject(project.id);
			// Register scope opts so internal paths (deliverMessage, ensureChildAgentRunning)
			// can look up the project's tools + prompt without passing them through every call.
			ctx.scopeOpts.set(project.id, scopeOpts);
			// Generic per-project startup hook — the plugin does its own bring-up
			// work here. Best-effort: never block agent resume on it.
			try {
				await scopeOpts.onScopeResume?.(tracker, project.id);
			} catch (e) {
				console.warn(`[autoResume] onScopeResume failed for ${project.id}:`, e);
			}
			await resumeScope(project, tracker, eventStore, scopeOpts);
		}
	}

	/** Graceful shutdown: stop all agents, await loop settlement, flush pending JSONL writes.
	 *
	 * Durability contract: when shutdown() returns, every event emitted up to that
	 * point MUST be on disk.
	 *
	 * Step 2 is what carries that contract. `eventStore.append` is synchronous,
	 * so an event is durable the moment `emitEvent` returns — but only for
	 * events that have actually been emitted, and an agent still inside its
	 * `finally` (agent_end from stopAgent, done_notified from Phase 2) has not
	 * emitted them yet. Awaiting the loops is what makes "up to that point"
	 * include those. Step 3 is now a formality for the append path (there is
	 * nothing queued to drain) and still real for `copySessionFrom`, the one
	 * async write left.
	 *
	 * Order matters:
	 *   1. stopAgent on every running project (emits agent_end, triggers finally cleanup)
	 *   2. await residual in-flight loops with bounded timeout (Phase 2 writes)
	 *   3. flush every EventStore
	 *
	 * The loop-wait timeout matches stopAgent's (3s): real providers abort within
	 * ms, stuck tools (foreground bash ignoring abort) get a bounded grace period.
	 * Exceeding the timeout is an orphan on next startup — the buildSessionRepair
	 * path handles that correctly via synthetic tool_results.
	 */
	const SHUTDOWN_LOOP_TIMEOUT_MS = 1_000;
	async function shutdown(): Promise<void> {
		// Stop all agents — their root nodes stay in_progress so they resume on next start.
		// stopAgent awaits loop settlement internally with its own bounded timeout.
		for (const [projectId, tracker] of ctx.trackers) {
			const rootNode = tracker.getTask(tracker.rootNodeId);
			if (rootNode?.session) {
				await stopAgent(ctx, projectId);
			}
		}
		// Residual in-flight agent loops (children still cleaning up after root
		// finally fires; Phase 2 tails; MCP disconnect). Bounded wait so a stuck
		// tool can't block shutdown indefinitely — orphan-repair on next startup
		// handles any mid-tool interruption.
		const pendingLoops = Array.from(ctx.agentLoopPromises.values());
		if (pendingLoops.length > 0) {
			await Promise.race([
				Promise.allSettled(pendingLoops),
				new Promise<void>((resolve) =>
					setTimeout(resolve, SHUTDOWN_LOOP_TIMEOUT_MS),
				),
			]);
		}
		// Flush every EventStore so queued async appends land on disk.
		const flushes = Array.from(ctx.eventStores.values()).map((store) =>
			store.flush(),
		);
		await Promise.all(flushes);
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
		autoResumeProjects,
		shutdown,
		getTracker: (projectId: string) => getTracker(ctx, projectId),
		markReady,
		loadConfig,
		getConfig: () => ctx.globalConfig,
	};
}

// Runtime is plugin-agnostic. Prompt + tools provided via config.buildScopeOpts.

// runtime.ts is a library — no standalone entry point.
// Production entry is daemon.ts. Tests import createApp() directly.
