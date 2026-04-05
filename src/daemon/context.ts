import type { AgentProvider } from "../agent-provider.ts";
import type { MatrixConfig } from "../config.ts";
import type { EventStore } from "../event-store.ts";
import type { ProjectManager } from "../project-manager.ts";
import type { TaskTracker } from "../task-tracker.ts";
import type { McpSessionStore } from "./mcp-session-state.ts";

/** SSE client connection subscribed to a project's event stream. */
export interface SSEClient {
	controller: ReadableStreamDefaultController;
	projectId: string;
}

/**
 * Generic event subscriber for in-process consumers (HTTP MCP await tool, etc.).
 * Called by broadcast() after SSE fanout. Callback receives the raw event object
 * (not SSE-encoded, not stripped). Subscribers MUST NOT throw — broadcast wraps
 * calls in try/catch but a throwing subscriber is a bug.
 */
export interface EventSubscriber {
	projectId: string;
	callback: (event: Record<string, unknown>) => void;
}

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
	 * Generic in-process event subscribers. Fanned out to by broadcast() after
	 * SSE clients. Used by the HTTP MCP `await` tool to watch for pause events.
	 */
	readonly eventSubscribers: Set<EventSubscriber>;
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
	 * Per-MCP-session attachment state for the HTTP MCP endpoint.
	 * Each external MCP client gets its own attached project/task.
	 */
	readonly mcpSessionStore: McpSessionStore;

	/** Mutable counters/flags */
	requestCount: number;
	startupReady: boolean;
	globalConfig: MatrixConfig;
}
