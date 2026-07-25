import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { useAuthFetch, useGetToken } from "./auth.ts";

export type {
	AgentActivity,
	GeneralNode,
	TaskNode,
	TaskStatus,
	TreeNode,
} from "./types.ts";
export { isFolder, isGeneral, isTask } from "./types.ts";

import type {
	AgentActivity,
	Event,
	OffChainReason,
	TreeNode,
} from "./types.ts";

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
			/**
			 * Full activity map, pushed by the daemon when an SSE stream opens.
			 * The "ASK" half of the model: a client that was disconnected across
			 * any number of transitions lands on the truth here instead of on
			 * whatever the last delta it happened to receive said. An EMPTY
			 * `states` is meaningful — it says "nothing is running".
			 */
			type: "agent_activity_snapshot";
			states: Record<string, AgentActivity>;
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
	/**
	 * React key. NOT a display value — it exists so that rebuilding the log
	 * from JSONL produces the SAME key for the same event, and React
	 * reconciles instead of remounting. See `createLogEntry`.
	 */
	id: number;
	/**
	 * The persisted event this entry was built from, when there is one.
	 * The durable name of this entry: survives a wholesale rebuild, a
	 * daemon restart and a fork. Absent for entries with no persisted
	 * counterpart (streamed text before its block closes, lifecycle notices
	 * the backend never writes).
	 */
	eid?: string;
	/**
	 * Why this entry is not part of the conversation, when it isn't. Only the
	 * raw-file fetch ("Load earlier history") can carry such entries, and the
	 * server marks them there; every other path delivers events that are on
	 * the chain by construction.
	 */
	offChain?: OffChainReason;
	taskId?: string;
	expanded?: boolean;
	/** Per-turn token/cache breakdown, attached from usage events. */
	cacheInfo?: CacheInfo;
	/**
	 * For user messages: did this message start a run of the agent? Decided
	 * from the DELIVERY order of the raw events (see run-start.ts) and
	 * attached in processEventBatch, because by the time a message reaches
	 * the log it has been reordered to where it was consumed.
	 *
	 * Absent when unknown — including on every live SSE entry, which carries
	 * no eid to decide about. Those show no Edit/Rewind buttons anyway.
	 */
	startsRun?: boolean;
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
	scope: string,
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
		// `scope` is the lens (plugin name) this stream subscribes to. Both are
		// required — without scope the daemon can't tell which lens's tree to
		// stream (matrix dev vs this project's product).
		if (!projectId || !scope) return;

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

			let url = `/events?projectId=${encodeURIComponent(projectId)}&scope=${encodeURIComponent(scope)}`;
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
		scope,
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
	const [provider, setProvider] = useState<string | null>(null);
	const [model, setModel] = useState<string | null>(null);

	/**
	 * Fetches which provider/model this project is configured with — config,
	 * not live state, which is why it may be polled at will.
	 *
	 * It used to ALSO pull `/agent/status` into an `activeAgents` set, and that
	 * poll existed to paper over a bug: replaying historical events made the UI
	 * believe stopped agents were running, so something had to overwrite the
	 * result afterwards. Activity now arrives as its own pushed state and can
	 * never be reconstructed from the log, so there is nothing left to correct.
	 */
	const checkStatus = useCallback(async () => {
		if (!projectId) {
			setProvider(null);
			setModel(null);
			return;
		}
		try {
			const res = await authFetch(api.agent(projectId));
			const data = await res.json();
			if (data.provider) setProvider(data.provider);
			if (data.model) setModel(data.model);
		} catch (e) {
			console.warn("[useAgent] Failed to fetch provider/model:", e);
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
			// The agent's own activity broadcast lights the UI up — no local
			// guess about what the backend is about to do.
		},
		[authFetch, projectId],
	);

	const stop = useCallback(async () => {
		const res = await authFetch(api.stop(projectId), {
			method: "POST",
		});
		// 404 means the session was already gone; the backend broadcast the
		// end of it either way, so there is no local state to reconcile.
		if (!res.ok && res.status !== 404) {
			throw new Error((await res.json()).error);
		}
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

/**
 * eid → entry id. What makes a rebuilt entry keep its React key.
 *
 * Never cleared. Clearing it is the failure this whole mechanism exists to
 * prevent: the moment it forgets an eid is the moment that entry gets a new
 * key and remounts. Bounded by the number of distinct events this browser
 * session has displayed (a few tens of thousands at worst, one small string
 * plus one number each) — small next to the entries themselves.
 */
const entryIdByEid = new Map<string, number>();

/**
 * Bind an eid to an id that was already handed out.
 *
 * For entries that exist BEFORE their persisted event does: a streamed text
 * block is created from `text_delta`, which is never written to disk, and
 * only learns its eid when the block closes. Binding — rather than
 * re-deriving the id — is why the key does not change at that moment.
 *
 * First binding wins, so this is idempotent.
 */
export function bindEntryId(eid: string, id: number): void {
	if (!entryIdByEid.has(eid)) entryIdByEid.set(eid, id);
}

/** The id for a persisted event. Same eid → same id, for the life of the page. */
export function entryIdForEid(eid: string): number {
	const existing = entryIdByEid.get(eid);
	if (existing !== undefined) return existing;
	const id = logIdCounter++;
	entryIdByEid.set(eid, id);
	return id;
}

/**
 * Create a LogEntry from a UIEvent by adding id.
 * Extra fields (like taskId for routing) can be passed and will be preserved.
 *
 * **`id` is derived from `eid` whenever there is one.** The log is rebuilt
 * wholesale on every refetch (reconnect, load-earlier, post-rollback), and a
 * fresh counter made every key change on every rebuild — measured as a
 * single MutationObserver batch removing 82 nodes and adding 82 back, which
 * empties the container for a frame and lets the browser clamp the scroll
 * offset to 0. Deriving the id from the event's durable name makes the
 * rebuild a reconcile: same keys, same DOM nodes, same scroll offset, and
 * component state (an expanded Card) survives.
 *
 * `reuseId` is for the one case where the entry predates its event — see
 * `bindEntryId`.
 */
export function createLogEntry(
	event: UIEvent & { taskId?: string; eid?: string; offChain?: OffChainReason },
	reuseId?: number,
): LogEntry {
	const eid = event.eid;
	let id: number;
	if (reuseId !== undefined) {
		id = reuseId;
		if (eid) bindEntryId(eid, id);
	} else if (eid) {
		id = entryIdForEid(eid);
	} else {
		id = logIdCounter++;
	}
	return { ...event, id } as LogEntry;
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
