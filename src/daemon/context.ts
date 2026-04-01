import type { AgentProvider, AgentSession } from "../agent-provider.ts";
import type { MatrixConfig } from "../config.ts";
import type { EventStore } from "../event-store.ts";
import type { ProjectManager } from "../project-manager.ts";
import type { TaskTracker } from "../task-tracker.ts";

/** SSE client connection subscribed to a project's event stream. */
export interface SSEClient {
	controller: ReadableStreamDefaultController;
	projectId: string;
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
	/**
	 * Enable auto-recovery from API 400 invalid_request_error.
	 * When true, the provider loop rolls back broken turns instead of crashing.
	 * Default: true (production). Tests should set false to avoid masking bugs.
	 */
	enableAutoRecovery?: boolean;
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
	readonly sseClients: Set<SSEClient>;
	readonly activeSessions: Map<string, AgentSession>;
	readonly pendingClarifications: Map<string, PendingClarification[]>;
	readonly eventStores: Map<string, EventStore>;

	/** Mutable counters/flags */
	requestCount: number;
	startupReady: boolean;
	globalConfig: MatrixConfig;
}
