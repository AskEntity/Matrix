import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { useAuthFetch, useGetToken } from "./auth.ts";

export type {
	GeneralNode,
	TaskNode,
	TaskStatus,
	TreeNode,
} from "./types.ts";
export { isFolder, isGeneral, isTask } from "./types.ts";

import type { Event, TreeNode } from "./types.ts";

export type { Event } from "./types.ts";

/**
 * UI-only event types that only exist in the frontend rendering layer.
 * Queue-originated message types (task_message, user_message_forwarded, etc.) are
 * created by event-handler.ts when materializing deferred messages.
 */
type UIOnlyEvent =
	| { type: "lifecycle"; content: string; taskId?: string; ts: number }
	| {
			type: "task_message";
			taskId?: string;
			fromTaskId?: string;
			fromTitle: string;
			title: string;
			content: string;
			requestReply?: boolean;
			ts: number;
	  }
	| {
			type: "user_message_forwarded";
			taskId?: string;
			fromTaskId?: string;
			title: string;
			content: string;
			resumed?: boolean;
			ts: number;
	  }
	| {
			type: "cross_project";
			fromProjectId: string;
			fromProjectName: string;
			content: string;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "background_complete";
			command: string;
			commandId: string;
			exitCode: number | null;
			durationMs: number;
			content: string;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "clarify_response";
			answer: string;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "task_completed";
			taskId?: string;
			fromTaskId?: string;
			title: string;
			success: boolean;
			output: string;
			ts: number;
	  }
	| {
			type: "tree_change";
			action: string;
			nodeId: string;
			title?: string;
			taskId?: string;
			ts: number;
	  }
	| {
			type: "tool_pair";
			tool: string;
			toolCallId: string;
			input: Record<string, unknown>;
			resultContent: string;
			isError: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			/** Structured pending state from tool_result. */
			pending?: {
				runningChildren: Array<{ id: string; title: string }>;
				pendingClarifications: number;
			};
			/** Background process ID — set when bash moves a command to background. */
			backgroundId?: string;
			/** Background command — set when bash moves a command to background. */
			backgroundCommand?: string;
			/** Timestamp of the tool_result event. */
			resultTs: number;
			taskId?: string;
			ts: number;
	  };

/** All event types the UI can display. */
export type UIEvent = Event | UIOnlyEvent;

/**
 * Events that arrive over SSE but aren't part of the backend Event union.
 * These are ephemeral server pushes for tree state and clarification state.
 */
export type SSEOnlyEvent =
	| {
			type: "tree_updated";
			nodes: TreeNode[];
			rootNodeId?: string;
	  }
	| {
			type: "pending_clarifications";
			clarifications: Array<{
				id: string;
				taskId: string;
				question: string;
				title?: string;
				body?: string;
				timestamp: number;
			}>;
	  }
	| { type: "heartbeat" };

/**
 * Everything that can arrive over SSE or from REST event endpoints.
 * This is the parse-boundary type — JSON.parse returns unknown, we cast to this once.
 */
export type IncomingEvent = UIEvent | SSEOnlyEvent;

/**
 * LogEntry = UIEvent + display metadata.
 * `id` for keying. Time is derived from `ts` on render.
 * `taskId` is added by event-handler to route entries to the correct task log.
 * Some UIEvent variants already have taskId (Event); for others it's
 * added as extra metadata via the intersection.
 */
/** Per-turn cache/token info attached from usage events. */
export interface CacheInfo {
	inputTokens: number;
	outputTokens?: number;
	cacheCreationTokens?: number;
	cacheReadTokens?: number;
}

export type LogEntry = UIEvent & {
	id: number;
	taskId?: string;
	expanded?: boolean;
	/** Per-turn token/cache breakdown, attached from usage events. */
	cacheInfo?: CacheInfo;
};

let logIdCounter = 0;

// --- useSSE ---

/** How often the watchdog checks for dead connections (ms). */
const WATCHDOG_CHECK_INTERVAL = 30_000;
/**
 * If no SSE data event received within this window, consider connection dead (ms).
 * Server sends data heartbeat every 15s. Timeout is 3x heartbeat = 45s.
 */
const WATCHDOG_TIMEOUT = 45_000;

export function useSSE(
	projectId: string,
	onMessage: (msg: IncomingEvent) => void,
	onConnect?: () => void,
	onReconnect?: () => void,
) {
	const getToken = useGetToken();
	const authFetch = useAuthFetch();
	const [connected, setConnected] = useState(false);
	// Bump to force EventSource re-creation when watchdog detects stale connection
	const [reconnectKey, setReconnectKey] = useState(0);
	// Use ref for watchdog timestamp — avoids re-renders on every heartbeat
	const lastMessageRef = useRef<number>(Date.now());

	useEffect(() => {
		if (!projectId) return;

		let cancelled = false;
		let source: EventSource | null = null;
		let watchdog: ReturnType<typeof setInterval> | null = null;

		(async () => {
			// If auth is enabled, fetch a short-lived stream token first so
			// the long-lived session token never appears in URLs / proxy
			// logs / browser history. Stream tokens expire in 5min; the
			// daemon re-verifies them each heartbeat and closes the stream
			// on expiry. The watchdog below notices and bumps reconnectKey,
			// which re-runs this effect → new stream token.
			let streamToken: string | null = null;
			if (getToken()) {
				try {
					const resp = await authFetch("/auth/stream-token", {
						method: "POST",
					});
					if (resp.ok) {
						const data = (await resp.json()) as { token: string | null };
						streamToken = data.token;
					}
				} catch {
					/* network blip — fall through and try without token; server 401s */
				}
			}
			if (cancelled) return;

			let url = `/events?projectId=${encodeURIComponent(projectId)}`;
			if (streamToken) url += `&token=${encodeURIComponent(streamToken)}`;
			source = new EventSource(url);
			lastMessageRef.current = Date.now();

			// Track whether this is the first connect or a reconnect.
			// reconnectKey > 0 means the watchdog forced re-creation — treat as reconnect.
			let hasConnectedBefore = reconnectKey > 0;

			source.onopen = () => {
				setConnected(true);
				lastMessageRef.current = Date.now();
				if (hasConnectedBefore) {
					// Reconnect — ring buffer may have caught up, but we also need
					// to re-fetch events in case the gap was too large
					onReconnect?.();
				}
				hasConnectedBefore = true;
				onConnect?.();
			};

			source.onmessage = (evt) => {
				lastMessageRef.current = Date.now();
				try {
					const data = JSON.parse(evt.data) as IncomingEvent;
					// Data heartbeats update lastMessageRef but aren't processed
					if (data.type === "heartbeat") return;
					onMessage(data);
				} catch (e) {
					console.warn("[SSE] Failed to parse message:", e);
				}
			};

			source.onerror = () => {
				setConnected(false);
				// EventSource auto-reconnects — no manual retry logic needed
			};

			// Daemon signals token revocation/expiry via a named event.
			// EventSource auto-reconnect would just resend the dead token,
			// so tear down and bump reconnectKey to refetch a fresh one.
			source.addEventListener("auth_expired", () => {
				source?.close();
				setConnected(false);
				setReconnectKey((k) => k + 1);
			});

			// Watchdog: detect silently dead connections and force reconnect.
			// Two cases:
			// 1. No data event (real or heartbeat) in 150s — connection silently died
			// 2. EventSource entered CLOSED state (e.g. CF Tunnel clean close) — won't auto-reconnect
			// In both cases, bump reconnectKey to tear down and re-create EventSource.
			watchdog = setInterval(() => {
				const elapsed = Date.now() - lastMessageRef.current;
				if (elapsed > WATCHDOG_TIMEOUT) {
					source?.close();
					setConnected(false);
					setReconnectKey((k) => k + 1);
				}
			}, WATCHDOG_CHECK_INTERVAL);
		})();

		return () => {
			cancelled = true;
			if (watchdog) clearInterval(watchdog);
			source?.close();
		};
	}, [
		authFetch,
		getToken,
		projectId,
		reconnectKey,
		onMessage,
		onConnect,
		onReconnect,
	]);

	return { connected };
}

// --- useTasks ---

export function useTasks(
	projectId: string,
	setRootNodeId?: React.Dispatch<React.SetStateAction<string | null>>,
) {
	const authFetch = useAuthFetch();
	const [nodes, setNodes] = useState<TreeNode[]>([]);

	const refresh = useCallback(async () => {
		if (!projectId) {
			setNodes([]);
			return;
		}
		try {
			const res = await authFetch(api.tasks(projectId));
			const data = await res.json();
			setNodes(data.nodes || []);
			if (data.rootNodeId && setRootNodeId) {
				setRootNodeId(data.rootNodeId);
			}
		} catch (e) {
			console.warn("[useTasks] Failed to fetch tasks:", e);
		}
	}, [authFetch, projectId, setRootNodeId]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const updateFromWS = useCallback((wsNodes: TreeNode[]) => {
		setNodes(wsNodes);
	}, []);

	return { nodes, refresh, updateFromWS };
}

// --- useAgent ---

export function useAgent(projectId: string) {
	const authFetch = useAuthFetch();
	const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
	const running = activeAgents.size > 0;
	const [provider, setProvider] = useState<string | null>(null);
	const [model, setModel] = useState<string | null>(null);

	const checkStatus = useCallback(async () => {
		if (!projectId) {
			setActiveAgents(new Set());
			setProvider(null);
			setModel(null);
			return;
		}
		try {
			// Fetch per-agent idle/active status
			const statusRes = await authFetch(api.agentStatus(projectId));
			if (statusRes.ok) {
				const statusData = (await statusRes.json()) as {
					idle: string[];
					active: string[];
				};
				setActiveAgents(new Set(statusData.active));
			}
			// Fetch provider/model from legacy endpoint
			const res = await authFetch(api.agent(projectId));
			const data = await res.json();
			if (data.provider) setProvider(data.provider);
			if (data.model) setModel(data.model);
		} catch (e) {
			console.warn("[useAgent] Failed to check agent status:", e);
		}
	}, [authFetch, projectId]);

	useEffect(() => {
		checkStatus();
	}, [checkStatus]);

	const start = useCallback(
		async (opts: { prompt: string }) => {
			// Get root node ID, then send message via unified endpoint
			const tasksRes = await authFetch(api.tasks(projectId));
			if (!tasksRes.ok) throw new Error("Failed to load tasks");
			const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
			const res = await authFetch(api.taskMessage(projectId, rootNodeId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: opts.prompt }),
			});
			if (!res.ok) throw new Error((await res.json()).error);
			// The orchestration_started SSE event will add the root to activeAgents
		},
		[authFetch, projectId],
	);

	const stop = useCallback(async () => {
		const res = await authFetch(api.stop(projectId), {
			method: "POST",
		});
		if (!res.ok) {
			// 404 means session already gone — reset UI running state to match.
			if (res.status === 404) {
				setActiveAgents(new Set());
				return;
			}
			throw new Error((await res.json()).error);
		}
		// agent_stopped WS event will clear activeAgents via checkStatus
	}, [authFetch, projectId]);

	const continueTask = useCallback(
		async (taskId: string, message?: string) => {
			const body: Record<string, unknown> = {};
			if (message) body.message = message;
			const res = await authFetch(api.taskContinue(projectId, taskId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error((await res.json()).error);
			return await res.json();
		},
		[authFetch, projectId],
	);

	const deleteTask = useCallback(
		async (taskId: string) => {
			const res = await authFetch(api.task(projectId, taskId), {
				method: "DELETE",
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[authFetch, projectId],
	);

	const stopTask = useCallback(
		async (taskId: string) => {
			const res = await authFetch(api.taskStop(projectId, taskId), {
				method: "POST",
			});
			if (!res.ok) {
				// 404 means agent already stopped — not an error
				if (res.status === 404) return;
				throw new Error((await res.json()).error);
			}
		},
		[authFetch, projectId],
	);

	const clearTaskSession = useCallback(
		async (taskId: string) => {
			const res = await authFetch(api.taskSessionsClear(projectId, taskId), {
				method: "POST",
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[authFetch, projectId],
	);

	const compact = useCallback(
		async (nodeId?: string) => {
			const res = await authFetch(api.compact(projectId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(nodeId ? { nodeId } : {}),
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[authFetch, projectId],
	);

	const sendMessageToTask = useCallback(
		async (
			taskId: string,
			content: string,
			images?: { base64: string; mediaType: string }[],
		) => {
			const body: Record<string, unknown> = { content };
			if (images?.length) body.images = images;
			const res = await authFetch(api.taskMessage(projectId, taskId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[authFetch, projectId],
	);

	const reorderTasks = useCallback(
		async (nodeId: string, children: string[]) => {
			const res = await authFetch(api.taskReorder(projectId, nodeId), {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ children }),
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[authFetch, projectId],
	);

	const reparentTask = useCallback(
		async (nodeId: string, newParentId: string) => {
			const res = await authFetch(api.task(projectId, nodeId), {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ parentId: newParentId }),
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[authFetch, projectId],
	);

	return {
		running,
		activeAgents,
		setActiveAgents,
		provider,
		setProvider,
		model,
		setModel,
		start,
		stop,
		compact,
		checkStatus,
		continueTask,
		deleteTask,
		stopTask,
		clearTaskSession,
		sendMessageToTask,
		reorderTasks,
		reparentTask,
	};
}

// --- Log helpers ---

/** Create a LogEntry from a UIEvent by adding id.
 * Extra fields (like taskId for routing) can be passed and will be preserved. */
export function createLogEntry(event: UIEvent & { taskId?: string }): LogEntry {
	return {
		...event,
		id: logIdCounter++,
	} as LogEntry;
}

/** Format a timestamp for display. */
export function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

/** Safely get taskId from any LogEntry — not all event types have it. */
export function getLogTaskId(entry: LogEntry): string | undefined {
	if ("taskId" in entry) return entry.taskId as string | undefined;
	return undefined;
}
