import type { WSContext } from "hono/ws";
import type { AgentProvider, AgentSession } from "../agent-provider.ts";
import type { OpenGraftConfig } from "../config.ts";
import type { EventStore } from "../event-store.ts";
import type { ProjectManager } from "../project-manager.ts";
import type { TaskTracker } from "../task-tracker.ts";

/** WebSocket client connection with project subscription. */
export interface WSClient {
	ws: WSContext;
	projectId: string | null;
}

/** Pending clarification from a clarify() call waiting for user answer. */
export interface PendingClarification {
	id: string;
	taskId: string;
	question: string;
	timestamp: number;
}

/** Configuration passed to createApp(). */
export interface DaemonConfig {
	dataDir: string;
	agentProvider?: AgentProvider;
	initialConfig?: OpenGraftConfig;
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
	readonly wsClients: Set<WSClient>;
	readonly activeSessions: Map<string, AgentSession>;
	readonly pendingClarifications: Map<string, PendingClarification[]>;
	readonly eventStores: Map<string, EventStore>;

	/** Mutable counters/flags */
	requestCount: number;
	startupReady: boolean;
	globalConfig: OpenGraftConfig;
}
