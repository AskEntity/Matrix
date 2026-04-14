import type { AgentProvider } from "../agent-provider.ts";
import type { MatrixConfig } from "../config.ts";
import type { EventStore } from "../event-store.ts";
import type { ProjectManager } from "../project-manager.ts";
import type { SystemPrompt } from "../system-prompts.ts";
import type { TaskTracker } from "../task-tracker.ts";
import type { Auth } from "../tool-auth.ts";
import type { ToolDefinition } from "../tool-definition.ts";

/**
 * Scope options for a project's run loop.
 * Determines what tools and prompt agents in this scope use.
 */
export interface ScopeOpts {
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
	/**
	 * Connect external MCP servers for this scope.
	 * Matrix reads mcpServers from resolved project config internally.
	 * Plugins handle their own MCP config or connect nothing.
	 */
	connectMcp?: (projectPath: string) => Promise<import("../mcp-client.ts").McpClientManager>;
	/**
	 * Prepare a child node before launching its agent.
	 * Matrix uses this to create git worktrees. Plugins may create
	 * different workspace structures or do nothing.
	 * Must set node.worktreePath if the agent needs a working directory
	 * different from the project root.
	 */
	beforeChildLaunch?: (
		node: import("../types.ts").TaskNode,
		tracker: import("../task-tracker.ts").TaskTracker,
		projectPath: string,
	) => Promise<void>;
	/**
	 * Should this node be resumed on daemon restart?
	 * Called for nodes that have JSONL but no running session.
	 * Matrix: true if status === "in_progress".
	 */
	shouldResume?: (node: import("../types.ts").TaskNode) => boolean;
	/**
	 * Update node state when an agent is launched.
	 * Matrix: sets status to "in_progress".
	 */
	onLaunch?: (
		node: import("../types.ts").TaskNode,
		tracker: import("../task-tracker.ts").TaskTracker,
	) => void;
	/**
	 * Update node state when an agent calls done().
	 * doneArgs is the opaque data from the done() tool call.
	 * Matrix: sets status to "verify" or "failed" based on doneArgs.status.
	 */
	onDone?: (
		node: import("../types.ts").TaskNode,
		tracker: import("../task-tracker.ts").TaskTracker,
		doneArgs: Record<string, unknown>,
	) => void;
}

/** SSE client connection subscribed to a project's event stream. */
export interface SSEClient {
	controller: ReadableStreamDefaultController;
	projectId: string;
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

/** Configuration passed to createApp(). */
export interface DaemonConfig {
	dataDir: string;
	agentProvider?: AgentProvider;
	initialConfig?: MatrixConfig;
	globalConfigPath?: string;
}

/**
 * Shared daemon context — passed to all route handlers and lifecycle functions.
 * Contains all shared mutable state that was previously captured via closure in createApp().
 */
export interface DaemonContext {
	readonly config: DaemonConfig;
	readonly pm: ProjectManager;
	readonly trackers: Map<string, TaskTracker>;
	readonly restartingProjects: Set<string>;
	/**
	 * Node IDs currently being launched (session setup in progress).
	 * Prevents duplicate launches when messages arrive before the session is established.
	 */
	readonly launchingNodes: Set<string>;
	readonly sseClients: Set<SSEClient>;
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
	 * Tracked agent loop promises per node ID.
	 * Stored when runAgentForNode starts, removed when it completes.
	 * Used by stopTask/resetTask to await loop exit before clearing JSONL.
	 */
	readonly agentLoopPromises: Map<string, Promise<void>>;

	/**
	 * Per-project scope configuration. Determines tools + prompt for agents.
	 * Set during autoResumeProjects or project registration.
	 */
	readonly scopeOpts: Map<string, ScopeOpts>;

	/** Mutable counters/flags */
	requestCount: number;
	startupReady: boolean;
	globalConfig: MatrixConfig;
}
