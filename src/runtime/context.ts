import type { AgentProvider } from "../agent-provider.ts";
import type { MatrixConfig } from "../config.ts";
import type { EventStore } from "../event-store.ts";
import type { ProjectStore } from "../project-store.ts";
import type { TaskTracker } from "../task-tracker.ts";
import type { Auth } from "../tool-auth.ts";
import type { ToolDefinition } from "../tool-definition.ts";
import type { BaseTaskNode } from "../types.ts";

/**
 * Split system prompt — the plugin-agnostic shape used throughout the
 * runtime. `stable` is cached across agents + days; `variable` carries
 * per-agent or per-day additions. Plugins provide the prompt text via
 * ScopeOpts.buildPrompt; the runtime cares only about the shape.
 */
export interface SystemPrompt {
	stable: string;
	variable: string;
}

/** Base done data — runtime only knows the agent finished. Plugins extend with fields. */
export interface BaseDoneData {
	[key: string]: unknown;
}

/**
 * Plugin type bundle — ties together all type extensions.
 * ONE generic parameter on ScopeOpts distributes node + done types everywhere.
 */
export interface PluginTypes {
	node: BaseTaskNode;
	done: BaseDoneData;
}

/**
 * Scope options for a project's run loop.
 * T flows through all callbacks — plugin authors get type-safe access to
 * their node + done data. Runtime stores ScopeOpts<PluginTypes> (erased).
 */
export interface ScopeOpts<T extends PluginTypes = PluginTypes> {
	// ── Agent behavior ──
	buildTools: (
		auth: Auth,
		taskId: string,
	) => {
		// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
		tools: ToolDefinition<any>[];
		hasRunningChildren?: () => boolean;
		setMessages?: (msgs: unknown[]) => void;
		setAllTools?: (tools: unknown[]) => void;
	};
	buildPrompt: () => SystemPrompt;

	// ── Infrastructure ──
	connectMcp?: (
		projectPath: string,
	) => Promise<import("../mcp-client.ts").McpClientManager>;
	beforeChildLaunch?: (
		node: T["node"],
		tracker: import("../task-tracker.ts").TaskTracker,
		projectPath: string,
	) => Promise<{ cwd: string } | void>;
	/**
	 * A task is being deleted — the plugin performs whatever cleanup that
	 * implies. Matrix removes the task's git worktree + branch; a plugin with
	 * no per-task resource omits this hook. Runtime delete routes call this and
	 * never manage worktrees (or any resource type) directly.
	 */
	onTaskDelete?: (node: T["node"], projectPath: string) => Promise<void>;

	// ── Context injection at lifecycle moments ──
	// These receive BOTH `projectPath` (the git/filesystem path) AND `projectId`
	// (the registry id). A plugin whose per-project data lives at its dataRoot
	// (`~/.mxd/projects/<projectId>/...`) needs `projectId` to locate it —
	// `projectPath` alone (the git checkout) is not enough. Matrix uses
	// `projectPath`; a data-driven plugin uses `projectId`.
	/** Fresh start / post-compact: inject work context. Required — runtime needs context for agents. */
	buildWorkContext: (
		node: T["node"],
		projectPath: string,
		projectId: string,
	) => string | null;
	/** Compaction: build the summarization instruction. */
	buildSummarizationPrompt: (
		node: T["node"],
		projectPath: string,
		projectId: string,
	) => string;
	/** Done resume: build the wake-up context text. */
	buildDoneResumeContext?: (
		node: T["node"],
		projectPath: string,
		projectId: string,
	) => string;

	// ── Lifecycle (typed with T) ──
	/**
	 * Seed a freshly-created project tree. Runs ONCE, in the worker, right
	 * after the tracker creates the root node for a project that had no
	 * tree.json yet — i.e. the worker-side counterpart to PluginManifest's
	 * daemon-side `onProjectInit` (which can create files but has no tracker).
	 * The plugin creates its starting nodes via tracker methods (addChild,
	 * addGeneralNode, setMetadata); the runtime saves the tree afterwards.
	 * Matrix has no seed nodes beyond the root, so it omits this hook.
	 * `projectId` lets the plugin locate its per-project data.
	 */
	seedTree?: (
		tracker: import("../task-tracker.ts").TaskTracker,
		projectId: string,
	) => void | Promise<void>;
	shouldResume?: (node: T["node"]) => boolean;
	onLaunch?: (
		node: T["node"],
		tracker: import("../task-tracker.ts").TaskTracker,
	) => void;
	onDone?: (
		node: T["node"],
		tracker: import("../task-tracker.ts").TaskTracker,
		doneArgs: Record<string, unknown>,
	) => T["done"];
}

/**
 * Generic event subscriber for in-process consumers (task hooks, test
 * utilities, future MCP endpoints, etc.). Registered via subscribeToEvents()
 * in event-system.ts, which keys subscribers by project and handles
 * unsubscribe symmetrically.
 *
 * Called by broadcast() after SSE fanout, for the project the subscriber is
 * registered under. Callback receives the RAW event object (not SSE-encoded,
 * not stripped) so subscribers see taskId and all routing fields. Exceptions
 * are swallowed — a throwing subscriber must not kill the broadcast.
 */
export type EventSubscriber = (event: Record<string, unknown>) => void;

/** Pending clarification from a clarify() call waiting for user answer. */
export interface PendingClarification {
	id: string;
	taskId: string;
	question: string;
	/** Short title extracted from question (first line). */
	title?: string;
	/** Detailed body (remaining lines after title). */
	body?: string;
	timestamp: number;
}

/**
 * Runtime worker configuration — passed to createApp().
 *
 * This lives inside the worker thread; the daemon (shell) constructs one
 * and ships it via postMessage or in-process test injection. The daemon
 * owns different state (auth, projects on disk, SSE fanout); this object
 * configures the worker runtime.
 */
export interface RuntimeConfig {
	dataDir: string;
	agentProvider?: AgentProvider;
	initialConfig?: MatrixConfig;
	globalConfigPath?: string;
	/** Initial project list — injected by daemon at worker init. */
	projects?: Array<{ id: string; name: string; path: string }>;
	/**
	 * Plugin-provided scope opts builder. Runtime calls this to get tools,
	 * prompt, hooks etc. for each project. Required — runtime throws on
	 * createApp() if missing (no silent fallback; each plugin owns its tools).
	 */
	// biome-ignore lint/suspicious/noExplicitAny: ScopeOpts generic varies by plugin
	buildScopeOpts?: (projectId: string, ctx: RuntimeContext) => ScopeOpts<any>;
	/**
	 * Plugin's optional route-registration hook. Plugins can register their
	 * own HTTP routes + middleware directly on the runtime's Hono app. Runs
	 * BEFORE built-in routes so plugin middleware can intercept matching paths.
	 *
	 * Use this for plugin-specific endpoints (e.g. matrix's /matrix-status) and
	 * guard middleware (e.g. matrix's production-mode mutation-blocker).
	 *
	 * Exported from the plugin runtime module as `registerRoutes`; the worker
	 * picks it up alongside `buildScopeOpts`.
	 */
	registerPluginRoutes?: (
		app: import("hono").Hono,
		ctx: RuntimeContext,
	) => void;
	/**
	 * Plugin's effective dataRoot. Determines where tree.json and tasks/ live.
	 * "@" = project root (default for Matrix), "@/plugin/<name>" = plugin subdirectory.
	 */
	dataRoot?: string;
	/** Daemon-computed global context — not user config. */
	globalContext?: {
		installRoot: string;
		gitHash: string | null;
		version: string;
	};
}

/**
 * Shared daemon context — passed to all route handlers and lifecycle functions.
 * Contains all shared mutable state that was previously captured via closure in createApp().
 */
export interface RuntimeContext {
	readonly config: RuntimeConfig;
	readonly pm: ProjectStore;
	readonly trackers: Map<string, TaskTracker>;
	readonly restartingProjects: Set<string>;
	/**
	 * Node IDs currently being launched (session setup in progress).
	 * Prevents duplicate launches when messages arrive before the session is established.
	 */
	readonly launchingNodes: Set<string>;
	/**
	 * In-process event subscribers keyed by projectId. Fanned out to by
	 * broadcast() after SSE clients. Use subscribeToEvents() to register
	 * and get an unsubscribe function — do NOT mutate this map directly.
	 */
	readonly eventSubscribers: Map<string, Set<EventSubscriber>>;
	readonly pendingClarifications: Map<string, PendingClarification[]>;
	readonly eventStores: Map<string, EventStore>;

	/**
	 * Accumulated streaming text per session (nodeId → partial text).
	 * Updated on each text_delta, cleared when assistant_text is emitted (response complete).
	 * Used to inject partial assistant_text into batch events API responses.
	 */
	readonly streamingText: Map<string, string>;

	/**
	 * Accumulated streaming thinking per session (nodeId → partial thinking buffer).
	 * Updated on each thinking_delta, cleared when the final thinking event is
	 * emitted (response complete). Used to inject partial `thinking` events into
	 * batch events API responses so a refresh mid-stream doesn't lose thinking
	 * content — thinking_delta events are ephemeral (never persisted).
	 *
	 * Parallel to `streamingText`; same lifecycle.
	 */
	readonly streamingThinking: Map<string, string>;

	/**
	 * Tracked agent loop promises per node ID.
	 * Stored when runAgentForNode starts, removed when it completes.
	 * Used by stopTask/resetTask to await loop exit before clearing JSONL.
	 */
	readonly agentLoopPromises: Map<string, Promise<void>>;

	/**
	 * Per-project scope configuration. Determines tools + prompt for agents.
	 * Set during autoResumeProjects or project registration.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: erased generic — runtime doesn't know the plugin's node type
	readonly scopeOpts: Map<string, ScopeOpts<any>>;

	/**
	 * Hook for relaying broadcast events to the parent thread (shell).
	 * When running in a Worker, set this to postMessage events to the shell
	 * for SSE relay. When running in-process (tests, standalone), leave undefined.
	 */
	onBroadcast?: (projectId: string, event: Record<string, unknown>) => void;

	/**
	 * Daemon-computed global context — installRoot, gitHash, version. Forwarded
	 * from RuntimeConfig.globalContext for convenient access by runtime code and
	 * plugin-registered routes/middleware.
	 */
	readonly globalContext?: {
		installRoot: string;
		gitHash: string | null;
		version: string;
	};

	/** Mutable counters/flags */
	requestCount: number;
	startupReady: boolean;
	globalConfig: MatrixConfig;
}
