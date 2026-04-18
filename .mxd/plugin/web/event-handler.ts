import type React from "react";
// ID generation — crypto.randomUUID() for local UI state
import {
	createLogEntry,
	getLogTaskId,
	type IncomingEvent,
	isTask,
	type LogEntry,
	type TreeNode,
	type UIEvent,
} from "./hooks.ts";
import { TOOL_YIELD } from "./tool-names.ts";
import type { QueueMessage } from "./types.ts";

// ── Pending messages: events-derived view, not mutable state ──
//
// Previous design had a `deferredMessages` Map, `syncPendingBanner` side
// effect, and multiple imperative clear paths (compact_marker,
// clearSessionState from tree_updated, processEventBatch reset). Fixes A/B/
// C/D all tried to patch the imperative model by shifting *when* mutations
// happen. Each fix closed one race, left others. Root cause was the
// model itself — pending isn't a state, it's a view of the events log.
//
// New model:
//   • pending = pure function of events log
//   • messages_consumed in the log ⇒ matching entries are no longer pending
//   • no "clear" action anywhere — compact_marker and tree_updated are
//     no-ops for pending
//   • reducer is O(1) per event (vs useMemo's O(N) per render)
//
// Unconsumed messages stay pending forever, which is semantically correct:
// if the user's message was never processed, the UI should keep surfacing
// it. Previously we "cleared" those on compact, which was lying about
// what actually happened.

/** Shape of one pending-message chip, matches the props consumers already use. */
export type PendingMessage = {
	id: string;
	taskId: string | null;
	text: string;
	timestamp: number;
	images?: Array<{ base64: string; mediaType: string }>;
	// Data required to materialize into a log entry when consumed:
	source: string | undefined;
	content: string;
	queueEntry: QueueMessage | undefined;
};

export type PendingAction =
	| { type: "RESET" }
	| { type: "APPLY"; event: IncomingEvent };

/**
 * Build the visible chip text for a pending message.
 * Pure: only reads its arguments. Called from the reducer and from tests.
 */
export function pendingChipText(
	source: string | undefined,
	content: string,
	queueEntry?: QueueMessage,
): string {
	if (!source || source === "user") return content;
	if (!queueEntry) return content || `[${source}]`;
	switch (queueEntry.source) {
		case "task_message": {
			if (queueEntry.title) return `↑ ${queueEntry.title}`;
			return queueEntry.fromTitle
				? `↑ ${queueEntry.fromTitle}: ${queueEntry.content}`
				: `↑ ${queueEntry.content}`;
		}
		case "user_message_forwarded":
			return `📨 ${queueEntry.fromTitle}: ${queueEntry.content}`;
		case "task_complete":
			return `${queueEntry.success ? "✓" : "✗"} ${queueEntry.title}`;
		case "clarify_response":
			return `💬 ${queueEntry.answer}`;
		case "cross_project":
			return `← ${queueEntry.fromProjectName}: ${queueEntry.content}`;
		case "background_complete":
			return `⚙ bg: ${queueEntry.command}`;
		case "tree_change": {
			const title = queueEntry.title ?? "";
			return title
				? `🌿 ${queueEntry.action}: ${title}`
				: `🌿 tree ${queueEntry.action}`;
		}
		default:
			return content || `[${source}]`;
	}
}

/**
 * Pure reducer: `(state, action) → nextState`. No closures, no I/O.
 *
 * - `RESET` → `[]` (used when processEventBatch starts over, e.g. on
 *   refresh or project switch)
 * - `APPLY(message event)` with id, non-compact source → append
 * - `APPLY(messages_consumed)` → filter out consumed ids
 * - all other events → state unchanged (pending is insensitive to
 *   compact_marker, tree_updated, thinking/text streaming, etc.)
 *
 * Compact-source messages are never added to pending. They have their
 * own display path via `compact_marker` → `complete_compact` update.
 * Excluding them at add-time means no cleanup path is needed later.
 */
export function pendingReducer(
	state: PendingMessage[],
	action: PendingAction,
): PendingMessage[] {
	if (action.type === "RESET") return [];
	const e = action.event;
	if (e.type === "message") {
		const body = e.body as QueueMessage | undefined;
		const source = body?.source;
		if (!e.id || source === "compact") return state;
		const content = body?.source === "user" ? body.content : "";
		const images = body?.source === "user" ? body.images : undefined;
		return [
			...state,
			{
				id: e.id,
				taskId: e.taskId ?? null,
				text: pendingChipText(source, content, body),
				timestamp: e.ts,
				images,
				source,
				content,
				queueEntry: body,
			},
		];
	}
	if (e.type === "messages_consumed" && e.messageIds?.length) {
		const consumed = new Set(e.messageIds);
		return state.filter((m) => !consumed.has(m.id));
	}
	return state;
}

// --- Update operations for in-place entry mutations ---

type UpdateOp =
	| {
			type: "merge_text";
			taskId: string | undefined;
			text: string;
			ts?: number;
	  }
	| {
			type: "replace_text";
			taskId: string | undefined;
			text: string;
			ts?: number;
	  }
	| {
			/**
			 * Monotonic extend for partial assistant_text snapshots. Snapshot only
			 * grows (deltas never retract). Semantics:
			 *   - if snapshot extends existing content (prefix + longer): adopt
			 *     snapshot
			 *   - if snapshot is shorter or equal: no-op (existing is ahead)
			 *   - if prefix mismatch and snapshot is longer: prefer snapshot + warn
			 *     (content drift — live deltas diverged from REST snapshot, which
			 *     shouldn't happen but we pick the longer to minimize data loss)
			 *
			 * Used for the REST batch-events path that injects partial events; the
			 * live SSE path uses merge_text for incremental deltas. Both paths can
			 * race: extend is the only shape that's safe in either direction.
			 */
			type: "extend_text";
			taskId: string | undefined;
			text: string;
			ts?: number;
	  }
	| {
			type: "merge_thinking";
			taskId: string | undefined;
			text: string;
			ts?: number;
	  }
	| {
			type: "replace_thinking";
			taskId: string | undefined;
			text: string;
			signature: string;
			ts?: number;
	  }
	| {
			/** Monotonic extend for partial thinking snapshots — see extend_text. */
			type: "extend_thinking";
			taskId: string | undefined;
			text: string;
			ts?: number;
	  }
	| {
			type: "complete_compact";
			text: string;
			savedTokens: number;
			taskId: string | undefined;
			ts?: number;
	  }
	| {
			type: "resolve_tool";
			toolCallId: string;
			tool: string;
			resultContent: string;
			isError: boolean;
			images?: Array<{ base64: string; mediaType: string }>;
			pending?: {
				runningChildren: Array<{ id: string; title: string }>;
				pendingClarifications: number;
			};
			backgroundId?: string;
			backgroundCommand?: string;
			resultTs: number;
	  }
	| {
			type: "remove_tool";
			toolCallId: string;
	  }
	| {
			type: "attach_usage";
			taskId: string | undefined;
			inputTokens: number;
			outputTokens?: number;
			cacheCreationTokens?: number;
			cacheReadTokens?: number;
			ts: number;
	  };

export interface EventHandlerDeps {
	updateFromWS: (nodes: TreeNode[]) => void;
	setRootNodeId: React.Dispatch<React.SetStateAction<string | null>>;
	setOlderEventsAvailable?: React.Dispatch<
		React.SetStateAction<Map<string, { hasOlder: boolean; oldestTs: number }>>
	>;
	setActiveAgents: React.Dispatch<React.SetStateAction<Set<string>>>;
	/** Re-check actual agent status from backend (GET /projects/:id/agent). */
	checkAgentStatus: () => void;
	setAgentProvider: (provider: string) => void;
	setAgentModel: (model: string) => void;
	setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
	setTokenUsage: React.Dispatch<
		React.SetStateAction<
			Record<string, { inputTokens: number; contextWindow: number }>
		>
	>;
	/**
	 * Apply a pending-state action (RESET or APPLY-event). Updates a shared
	 * ref synchronously so messages_consumed in the same batch can look up
	 * what's currently pending, then triggers a React re-render so consumers
	 * (AppFooter banner) see the new state.
	 */
	dispatchPending: (action: PendingAction) => void;
	/**
	 * Synchronous snapshot of the current pending messages (backed by a ref
	 * on the consumer side, updated eagerly by dispatchPending). Used by
	 * messages_consumed to materialize pending entries into activity-log
	 * entries at the consumption position.
	 */
	getPendingMessages: () => PendingMessage[];
	setPendingClarifications: React.Dispatch<
		React.SetStateAction<
			{ id: string; taskId: string; question: string; timestamp: number }[]
		>
	>;
	setLastTurns: React.Dispatch<React.SetStateAction<number | null>>;
	setLastInputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastCacheCreationTokens: React.Dispatch<
		React.SetStateAction<number | null>
	>;
	setLastCacheReadTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastOutputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setBackgroundProcesses: React.Dispatch<
		React.SetStateAction<
			Map<
				string,
				{
					id: string;
					command: string;
					startTime: number;
					taskId?: string;
				}
			>
		>
	>;
	t: (key: string, params?: Record<string, string>) => string;
	/** Returns the currently viewed session ID (= selectedTaskId after Fix C; only during the brand-new-project transient does the rootNodeId fallback matter). Used to filter SSE events. */
	getViewedSessionId?: () => string | null;
}

export function createEventHandler(deps: EventHandlerDeps) {
	const {
		updateFromWS,
		setRootNodeId,
		setOlderEventsAvailable,
		setActiveAgents,
		checkAgentStatus,
		setAgentProvider,
		setAgentModel,
		setLogs,
		setTokenUsage,
		dispatchPending,
		getPendingMessages,
		setPendingClarifications,
		setLastTurns,
		setLastInputTokens,
		setLastCacheCreationTokens,
		setLastCacheReadTokens,
		setLastOutputTokens,
		setBackgroundProcesses,
	} = deps;

	/** Fallback map: toolCallId → tool name, for old JSONL files missing tool field on tool_result. */
	const toolCallToolNames = new Map<string, string>();

	/**
	 * Convert a QueueMessage body into a UIEvent for rendering.
	 * Works for both live SSE messages AND JSONL body fields.
	 * Returns null for sources that should be skipped.
	 */
	function queueEntryToUIEvent(
		qe: QueueMessage,
		parentTaskId: string | undefined,
		ts: number,
	): UIEvent | null {
		const eventTs = ts;
		switch (qe.source) {
			// Compact messages are internal — never shown in activity log
			case "compact":
				return null;
			case "task_complete":
				// Render as task_completed card at consumption time
				return {
					type: "task_completed",
					taskId: parentTaskId,
					fromTaskId: qe.taskId,
					title: qe.title,
					success: qe.success,
					output: qe.output,
					ts: eventTs,
				};
			case "tree_change":
				return {
					type: "tree_change",
					action: qe.action,
					nodeId: qe.nodeId,
					title: qe.title,
					taskId: parentTaskId,
					ts: eventTs,
				};
			case "user":
				// User messages use the two-phase lifecycle (pending → consumed)
				// When called from materialization, we DO want to show them
				return {
					type: "message",
					id: "",
					body: {
						source: "user",
						id: qe.id,
						ts: qe.ts ?? Date.now(),
						content: qe.content,
						...(qe.images?.length ? { images: qe.images } : {}),
					},
					taskId: parentTaskId ?? "",
					ts: eventTs,
				};
			case "task_message":
				return {
					type: "task_message",
					taskId: parentTaskId,
					fromTaskId: qe.fromTaskId,
					fromTitle: qe.fromTitle,
					title: qe.title ?? "",
					content: qe.content,
					...(qe.requestReply ? { requestReply: true } : {}),
					ts: eventTs,
				};
			case "user_message_forwarded":
				return {
					type: "user_message_forwarded",
					taskId: parentTaskId,
					fromTaskId: qe.fromTaskId,
					title: qe.fromTitle,
					content: qe.content,
					...(qe.resumed ? { resumed: true } : {}),
					ts: eventTs,
				};
			case "background_complete":
				return {
					type: "background_complete",
					command: qe.command,
					commandId: qe.commandId,
					exitCode: qe.exitCode,
					durationMs: qe.durationMs,
					content: qe.content,
					taskId: parentTaskId,
					ts: eventTs,
				};
			case "cross_project":
				return {
					type: "cross_project",
					fromProjectId: qe.fromProjectId,
					fromProjectName: qe.fromProjectName,
					content: qe.content,
					taskId: parentTaskId,
					ts: eventTs,
				};
			case "clarify_response":
				return {
					type: "clarify_response",
					answer: qe.answer,
					taskId: parentTaskId,
					ts: eventTs,
				};
			default:
				return null;
		}
	}

	// --- Unified event processing ---

	interface ProcessResult {
		entries: LogEntry[];
		updates: UpdateOp[];
		/**
		 * Reducer actions to apply to the pending-messages view AFTER
		 * `entries`/`updates` are processed. Driver (processEventBatch /
		 * handleEvent) dispatches these synchronously so messages_consumed
		 * later in the same batch can read the current pending state via
		 * `deps.getPendingMessages()`. Optional — omit when the event doesn't
		 * affect pending.
		 */
		pendingActions?: PendingAction[];
		sideEffects: () => void;
	}

	const NO_SIDE_EFFECTS = () => {};

	/** Materialize a PendingMessage into a LogEntry at the given consumption ts. */
	function materializeFromPending(
		p: PendingMessage,
		ts: number,
	): LogEntry | null {
		// Non-user sources: render as the appropriate card type from the queueEntry
		if (p.queueEntry && p.source && p.source !== "user") {
			const uiEvent = queueEntryToUIEvent(
				p.queueEntry,
				p.taskId ?? undefined,
				ts,
			);
			return uiEvent ? createLogEntry(uiEvent) : null;
		}
		// User messages (or no source): render as message
		return createLogEntry({
			type: "message",
			id: "",
			body: {
				source: "user",
				id: crypto.randomUUID(),
				ts: Date.now(),
				content: p.content,
				...(p.images?.length ? { images: p.images } : {}),
			},
			taskId: p.taskId ?? "",
			ts,
		});
	}

	/**
	 * Filter out log entries and older-events state for sessions transitioning
	 * to status=pending. This does NOT touch pending messages — pending is a
	 * pure events-derived view (see module-level pendingReducer) and is not
	 * tied to task lifecycle status. Log cleanup is a separate concern.
	 */
	function clearSessionState(clearedSessionIds: Set<string>): void {
		if (clearedSessionIds.size === 0) return;
		setLogs((prev) =>
			prev.filter((entry) => {
				const taskId = getLogTaskId(entry);
				return !taskId || !clearedSessionIds.has(taskId);
			}),
		);
		setOlderEventsAvailable?.((prev) => {
			const next = new Map(prev);
			for (const sessionId of clearedSessionIds) {
				next.delete(sessionId);
			}
			return next;
		});
	}

	/**
	 * Single event → entries, in-place updates, and side effects.
	 * THE unified event processor — used by both live SSE and batch processing.
	 * Accepts typed IncomingEvent — discriminated union narrowing eliminates all `as` casts.
	 */
	function processEvent(msg: IncomingEvent): ProcessResult {
		switch (msg.type) {
			case "tree_updated":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						updateFromWS(msg.nodes);
						if (msg.rootNodeId) setRootNodeId(msg.rootNodeId);

						const clearedSessionIds = new Set(
							msg.nodes
								.filter((node) => isTask(node) && node.status === "pending")
								.map((node) => node.id),
						);
						clearSessionState(clearedSessionIds);
					},
				};

			// SSE-only events that processEvent doesn't handle
			case "pending_clarifications":
			case "heartbeat":
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			// --- Provider events (flat Event types) ---

			case "tool_call": {
				if (msg.tool && msg.toolCallId)
					toolCallToolNames.set(msg.toolCallId, msg.tool);
				return {
					entries: [
						createLogEntry({
							type: "tool_call",
							tool: msg.tool,
							toolCallId: msg.toolCallId,
							input: msg.input ?? {},
							taskId: msg.taskId,
							ts: msg.ts,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "tool_result": {
				const trTool = msg.tool || toolCallToolNames.get(msg.toolCallId) || "";

				// Yield tool_result: remove the tool_call entry entirely
				if (trTool === TOOL_YIELD) {
					return {
						entries: [],
						updates: [{ type: "remove_tool", toolCallId: msg.toolCallId }],
						sideEffects: NO_SIDE_EFFECTS,
					};
				}

				// Normal tool_result: replace matching tool_call with tool_pair
				return {
					entries: [],
					updates: [
						{
							type: "resolve_tool",
							toolCallId: msg.toolCallId,
							tool: trTool,
							resultContent: msg.content || "",
							isError: msg.isError || false,
							images: msg.images,
							pending: msg.pending,
							backgroundId: msg.backgroundId,
							backgroundCommand: msg.backgroundCommand,
							resultTs: msg.ts,
						},
					],
					sideEffects: msg.backgroundId
						? () => {
								const bgId = msg.backgroundId as string;
								setBackgroundProcesses((prev) => {
									const next = new Map(prev);
									next.set(bgId, {
										id: bgId,
										command: msg.backgroundCommand ?? "",
										startTime: msg.ts,
										taskId: msg.taskId,
									});
									return next;
								});
							}
						: NO_SIDE_EFFECTS,
				};
			}

			case "text_delta": {
				if (!msg.content) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				return {
					entries: [],
					updates: [
						{
							type: "merge_text",
							taskId: msg.taskId,
							text: msg.content,
							ts: msg.ts,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "thinking": {
				// Two shapes arrive at this case:
				//   1) Final persisted thinking block → authoritative, replace_thinking
				//   2) Synthetic `partial:true` snapshot from the batch-events REST
				//      path while streaming is still in progress → monotonic
				//      extend_thinking (never shrink state, tolerate races with live
				//      thinking_delta deltas).
				if ((msg as { partial?: boolean }).partial) {
					return {
						entries: [],
						updates: [
							{
								type: "extend_thinking",
								taskId: msg.taskId,
								text: msg.thinking,
								ts: msg.ts,
							},
						],
						sideEffects: NO_SIDE_EFFECTS,
					};
				}
				return {
					entries: [],
					updates: [
						{
							type: "replace_thinking",
							taskId: msg.taskId,
							text: msg.thinking,
							signature: msg.signature,
							ts: msg.ts,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "thinking_delta": {
				// Ephemeral thinking streaming — merge into thinking entry
				const thinkingText = (msg as { thinking?: string }).thinking;
				if (!thinkingText) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				return {
					entries: [],
					updates: [
						{
							type: "merge_thinking",
							taskId: msg.taskId,
							text: thinkingText,
							ts: msg.ts,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "assistant_text": {
				if (!msg.content) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				// Parallel to case "thinking": partial:true snapshots from the
				// batch-events REST path use monotonic extend semantics so they
				// can't overwrite live text_delta content that's already ahead.
				if ((msg as { partial?: boolean }).partial) {
					return {
						entries: [],
						updates: [
							{
								type: "extend_text",
								taskId: msg.taskId,
								text: msg.content,
								ts: msg.ts,
							},
						],
						sideEffects: NO_SIDE_EFFECTS,
					};
				}
				return {
					entries: [],
					updates: [
						{
							type: "replace_text",
							taskId: msg.taskId,
							text: msg.content,
							ts: msg.ts,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "usage":
				return {
					entries: [],
					updates: [
						{
							type: "attach_usage",
							taskId: msg.taskId || undefined,
							inputTokens: msg.inputTokens,
							outputTokens: msg.outputTokens,
							cacheCreationTokens: msg.cacheCreationTokens,
							cacheReadTokens: msg.cacheReadTokens,
							ts: msg.ts,
						},
					],
					sideEffects: () => {
						const usageKey = msg.taskId || "orchestrator";
						setTokenUsage((prev) => ({
							...prev,
							[usageKey]: {
								inputTokens: msg.inputTokens,
								contextWindow: msg.contextWindow,
							},
						}));
					},
				};

			case "compact_started":
				return {
					entries: [
						createLogEntry({
							type: "compact_started",
							taskId: msg.taskId,
							ts: msg.ts,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "compact_marker":
				// No-op for pending: in the events-derived model, compact is
				// a reset boundary for log display but NOT for pending state.
				// Unconsumed messages stay pending (semantically correct — if
				// the agent never processed them, the UI should keep them
				// visible). Compact-source messages never enter pending (see
				// `case "message"` above), so there's nothing to "clean up".
				return {
					entries: [],
					updates: [
						{
							type: "complete_compact",
							text: `Context compacted (saved ~${msg.savedTokens} tokens)`,
							savedTokens: msg.savedTokens,
							taskId: msg.taskId,
							ts: msg.ts,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "fork_marker":
				return {
					entries: [
						createLogEntry({
							type: "fork_marker",
							sourceTaskId: msg.sourceTaskId,
							taskId: msg.taskId,
							ts: msg.ts,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "status":
				// Status events are internal — no log entries
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			// --- Lifecycle events ---

			case "agent_start": {
				const entries: LogEntry[] = [];
				if (msg.resume) {
					entries.push(
						createLogEntry({
							type: "lifecycle",
							content: "▶ Agent started",
							taskId: msg.taskId,
							ts: msg.ts,
						}),
					);
				}
				return {
					entries,
					updates: [],
					sideEffects: () => {
						if (msg.taskId) {
							setActiveAgents((prev) => new Set(prev).add(msg.taskId));
						}
						if (msg.provider) setAgentProvider(msg.provider);
						if (msg.model) setAgentModel(msg.model);
					},
				};
			}

			case "agent_end": {
				const entries: LogEntry[] = [];
				if (msg.reason === "stopped") {
					entries.push(
						createLogEntry({
							type: "lifecycle",
							content: "⏹ Agent stopped",
							taskId: msg.taskId,
							ts: msg.ts,
						}),
					);
				}
				return {
					entries,
					updates: [],
					sideEffects: () => {
						if (msg.stats?.turns !== undefined) setLastTurns(msg.stats.turns);
						if (msg.stats?.inputTokens !== undefined)
							setLastInputTokens(msg.stats.inputTokens);
						if (msg.stats?.cacheCreationTokens !== undefined)
							setLastCacheCreationTokens(msg.stats.cacheCreationTokens);
						if (msg.stats?.cacheReadTokens !== undefined)
							setLastCacheReadTokens(msg.stats.cacheReadTokens);
						if (msg.stats?.outputTokens !== undefined)
							setLastOutputTokens(msg.stats.outputTokens);
						if (msg.taskId) {
							setActiveAgents((prev) => {
								const next = new Set(prev);
								next.delete(msg.taskId);
								return next;
							});
						}
						checkAgentStatus();
					},
				};
			}

			case "agent_active":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						if (msg.taskId) {
							setActiveAgents((prev) => new Set(prev).add(msg.taskId));
						}
					},
				};

			case "agent_idle":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						if (msg.taskId) {
							setActiveAgents((prev) => {
								const next = new Set(prev);
								next.delete(msg.taskId);
								return next;
							});
						}
					},
				};

			case "task_completed":
				// UIOnlyEvent — materialized from task_complete queue messages
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			case "message": {
				const { body } = msg;
				const source = body?.source;
				const umId = msg.id || undefined;
				const umContent = body && body.source === "user" ? body.content : "";
				const umImages = body?.source === "user" ? body.images : undefined;

				if (umId) {
					// Compact-source messages have their own display path via
					// compact_marker → complete_compact. Skip entirely: no
					// pending entry, no log entry. (This is why the old code
					// needed compact_marker.clear() — it was cleaning up the
					// compact source message that got added to deferred. In
					// the new model we just never add it.)
					if (source === "compact") {
						return {
							entries: [],
							updates: [],
							sideEffects: NO_SIDE_EFFECTS,
						};
					}

					// Remove completed background processes immediately on receipt
					const bgCompleteId =
						body?.source === "background_complete" ? body.commandId : undefined;

					// message with id → appended to pending via reducer. Driver
					// dispatches the APPLY action so the next messages_consumed in
					// the same batch sees it via deps.getPendingMessages().
					return {
						entries: [],
						updates: [],
						pendingActions: [{ type: "APPLY", event: msg }],
						sideEffects: bgCompleteId
							? () => {
									setBackgroundProcesses((prev) => {
										const next = new Map(prev);
										next.delete(bgCompleteId);
										return next;
									});
								}
							: NO_SIDE_EFFECTS,
					};
				}

				// message without id = initial prompt or internal event
				// If it has a body with non-user source, render as the appropriate card type
				if (body && source && source !== "user") {
					const uiEvent = queueEntryToUIEvent(
						body,
						msg.taskId ?? undefined,
						msg.ts,
					);
					if (uiEvent) {
						return {
							entries: [createLogEntry(uiEvent)],
							updates: [],
							sideEffects: NO_SIDE_EFFECTS,
						};
					}
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}

				// Plain user message → show directly in activity log
				return {
					entries: [
						createLogEntry({
							type: "message",
							id: umId ?? "",
							body: {
								source: "user",
								id: umId ?? crypto.randomUUID(),
								ts: Date.now(),
								content: umContent,
								...(umImages?.length ? { images: umImages } : {}),
							},
							taskId: msg.taskId ?? "",
							ts: msg.ts,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "messages_consumed": {
				// Move consumed messages from pending to activity log.
				// Materialize by looking up the pending entry via the
				// synchronous getPendingMessages snapshot, then emit a
				// pending-action so the reducer filters the entry out on the
				// driver's dispatch.
				const consumedIds = new Set(msg.messageIds);
				if (consumedIds.size === 0) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				const newEntries: LogEntry[] = [];
				for (const p of getPendingMessages()) {
					if (consumedIds.has(p.id)) {
						const entry = materializeFromPending(p, msg.ts);
						if (entry) newEntries.push(entry);
					}
				}
				return {
					entries: newEntries,
					updates: [],
					pendingActions: [{ type: "APPLY", event: msg }],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "error":
				return {
					entries: [
						createLogEntry({
							type: "error",
							message: msg.message,
							taskId: msg.taskId ?? "",
							ts: msg.ts,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			default:
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
		}
	}

	// --- Update application helper ---

	/**
	 * Apply a single UpdateOp to an entries array. Pure function — returns a new array.
	 * Used by both batch processing and live React state updates.
	 */
	function applyUpdate(entries: LogEntry[], op: UpdateOp): LogEntry[] {
		switch (op.type) {
			case "merge_text": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
						const updated = [...entries];
						updated[i] = { ...e, content: e.content + op.text };
						return updated;
					}
					// Skip thinking entries — they interleave with text in the same turn
					if (e && e.type === "thinking" && e.taskId === op.taskId) continue;
					if (e && getLogTaskId(e) === op.taskId && e.type !== "assistant_text")
						break;
				}
				return [
					...entries,
					createLogEntry({
						type: "assistant_text",
						content: op.text,
						taskId: op.taskId ?? "",
						ts: op.ts ?? Date.now(),
					}),
				];
			}
			case "replace_text": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
						const updated = [...entries];
						// Use persisted event's ts so refresh matches JSONL reconstruction
						updated[i] = { ...e, content: op.text, ts: op.ts ?? e.ts };
						return updated;
					}
					// Skip thinking entries — they interleave with text in the same turn
					if (e && e.type === "thinking" && e.taskId === op.taskId) continue;
					if (e && getLogTaskId(e) === op.taskId && e.type !== "assistant_text")
						break;
				}
				return [
					...entries,
					createLogEntry({
						type: "assistant_text",
						content: op.text,
						taskId: op.taskId ?? "",
						ts: op.ts ?? Date.now(),
					}),
				];
			}
			case "merge_thinking": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "thinking" && e.taskId === op.taskId) {
						const updated = [...entries];
						updated[i] = {
							...e,
							thinking:
								(e as unknown as { thinking: string }).thinking + op.text,
						};
						return updated;
					}
					// Skip assistant_text — it interleaves with thinking in the same turn
					if (e && e.type === "assistant_text" && e.taskId === op.taskId)
						continue;
					if (e && getLogTaskId(e) === op.taskId && e.type !== "thinking")
						break;
				}
				return [
					...entries,
					createLogEntry({
						type: "thinking",
						thinking: op.text,
						signature: "",
						taskId: op.taskId ?? "",
						ts: op.ts ?? Date.now(),
					}),
				];
			}
			case "replace_thinking": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "thinking" && e.taskId === op.taskId) {
						const updated = [...entries];
						updated[i] = {
							...e,
							thinking: op.text,
							signature: op.signature,
							// Use persisted event's ts so refresh matches JSONL reconstruction
							ts: op.ts ?? e.ts,
						};
						return updated;
					}
					// Skip assistant_text — it interleaves with thinking in the same turn
					if (e && e.type === "assistant_text" && e.taskId === op.taskId)
						continue;
					if (e && getLogTaskId(e) === op.taskId && e.type !== "thinking")
						break;
				}
				return [
					...entries,
					createLogEntry({
						type: "thinking",
						thinking: op.text,
						signature: op.signature,
						taskId: op.taskId ?? "",
						ts: op.ts ?? Date.now(),
					}),
				];
			}
			case "extend_text": {
				// Monotonic extend: adopt snapshot only when it grows state; never
				// shrink. Safe against live merge_text deltas that may have already
				// advanced past the snapshot (SSE + REST-snapshot race on refresh).
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
						const existing = e.content;
						if (op.text.length <= existing.length) {
							// Snapshot is stale or equal — existing is ahead, keep it.
							return entries;
						}
						if (!op.text.startsWith(existing)) {
							// Content drift — prefixes don't match. Prefer the longer
							// string to minimize data loss, but warn because this
							// shouldn't happen when deltas are strictly additive.
							console.warn("[extend_text] content drift, preferring longer", {
								existingLen: existing.length,
								newLen: op.text.length,
							});
						}
						const updated = [...entries];
						updated[i] = { ...e, content: op.text };
						return updated;
					}
					// Skip thinking entries — they interleave with text in the same turn
					if (e && e.type === "thinking" && e.taskId === op.taskId) continue;
					if (e && getLogTaskId(e) === op.taskId && e.type !== "assistant_text")
						break;
				}
				return [
					...entries,
					createLogEntry({
						type: "assistant_text",
						content: op.text,
						taskId: op.taskId ?? "",
						ts: op.ts ?? Date.now(),
					}),
				];
			}
			case "extend_thinking": {
				// Monotonic extend: see extend_text for semantics.
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "thinking" && e.taskId === op.taskId) {
						const existing = (e as unknown as { thinking: string }).thinking;
						if (op.text.length <= existing.length) {
							return entries;
						}
						if (!op.text.startsWith(existing)) {
							console.warn(
								"[extend_thinking] content drift, preferring longer",
								{
									existingLen: existing.length,
									newLen: op.text.length,
								},
							);
						}
						const updated = [...entries];
						updated[i] = { ...e, thinking: op.text };
						return updated;
					}
					// Skip assistant_text — it interleaves with thinking in the same turn
					if (e && e.type === "assistant_text" && e.taskId === op.taskId)
						continue;
					if (e && getLogTaskId(e) === op.taskId && e.type !== "thinking")
						break;
				}
				return [
					...entries,
					createLogEntry({
						type: "thinking",
						thinking: op.text,
						signature: "",
						taskId: op.taskId ?? "",
						ts: op.ts ?? Date.now(),
					}),
				];
			}
			case "complete_compact": {
				const replacement = createLogEntry({
					type: "compact_marker",
					savedTokens: op.savedTokens,
					taskId: op.taskId ?? "",
					ts: op.ts ?? Date.now(),
				});
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "compact_started") {
						// Preserve the original entry's timestamp
						(replacement as { ts: number }).ts = e.ts;
						// Truncate everything from compact_started onward — the checkpoint
						// assistant_text emitted between compact_started and compact_marker
						// is an internal artifact, not a conversation turn. Keep only entries
						// before compact_started + the new compact_marker.
						return [...entries.slice(0, i), replacement];
					}
				}
				// Fallback: no compact_started found (e.g., historical replay starting
				// from compact_marker via readFromLastCompactMarker). Just append.
				return [...entries, replacement];
			}
			case "resolve_tool": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "tool_call" && e.toolCallId === op.toolCallId) {
						const updated = [...entries];
						updated[i] = createLogEntry({
							type: "tool_pair",
							tool: e.tool,
							toolCallId: e.toolCallId,
							input: e.input,
							resultContent: op.resultContent,
							isError: op.isError,
							images: op.images,
							pending: op.pending,
							backgroundId: op.backgroundId,
							backgroundCommand: op.backgroundCommand,
							resultTs: op.resultTs,
							taskId: e.taskId,
							ts: e.ts,
						});
						return updated;
					}
				}
				// Orphan tool_result — no matching tool_call found
				return [
					...entries,
					createLogEntry({
						type: "tool_pair",
						tool: op.tool,
						toolCallId: op.toolCallId,
						input: {},
						resultContent: op.resultContent,
						isError: op.isError,
						images: op.images,
						pending: op.pending,
						backgroundId: op.backgroundId,
						backgroundCommand: op.backgroundCommand,
						resultTs: op.resultTs,
						ts: op.resultTs,
					}),
				];
			}
			case "remove_tool": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (
						e &&
						(e.type === "tool_call" || e.type === "tool_pair") &&
						e.toolCallId === op.toolCallId
					) {
						return entries.filter((_, idx) => idx !== i);
					}
				}
				return entries;
			}
			case "attach_usage": {
				// Walk backwards to find the most recent assistant_text for this task
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (
						e &&
						e.type === "assistant_text" &&
						e.taskId === (op.taskId ?? "")
					) {
						const updated = [...entries];
						updated[i] = {
							...e,
							cacheInfo: {
								inputTokens: op.inputTokens,
								outputTokens: op.outputTokens,
								cacheCreationTokens: op.cacheCreationTokens,
								cacheReadTokens: op.cacheReadTokens,
							},
						};
						return updated;
					}
				}
				// No assistant_text found — nothing to attach to
				return entries;
			}
		}
	}

	/**
	 * Process a batch of events (used for REST-fetched event history on page load/reconnect).
	 * Resets all state and reprocesses from scratch through the unified processEvent path.
	 */
	function processEventBatch(events: IncomingEvent[]): void {
		// Reset per-batch state — reprocessing from scratch. Pending reducer
		// also resets to []; message events in the batch will re-populate it.
		toolCallToolNames.clear();
		setBackgroundProcesses(new Map());
		dispatchPending({ type: "RESET" });

		let entries: LogEntry[] = [];
		const deferredSideEffects: (() => void)[] = [];

		for (const evt of events) {
			// Skip provider-internal prompt events (message with empty id)
			if (evt.type === "message" && !evt.id) {
				continue;
			}
			// Skip tree_updated from historical JSONL — old code versions persisted these
			// ephemeral events. Stale/empty nodes arrays overwrite current tree state.
			// Tree state comes from the REST /tasks endpoint, not from JSONL.
			if (evt.type === "tree_updated") {
				continue;
			}

			const result = processEvent(evt);
			for (const entry of result.entries) entries.push(entry);
			for (const op of result.updates) entries = applyUpdate(entries, op);
			// Pending actions MUST dispatch synchronously so the next event's
			// processEvent (e.g. a subsequent messages_consumed) sees the
			// already-applied message in getPendingMessages.
			if (result.pendingActions) {
				for (const action of result.pendingActions) dispatchPending(action);
			}
			// Collect side effects but DON'T execute them yet. These are the
			// React state-update closures that don't need to interleave with
			// processing (e.g. setBackgroundProcesses, checkAgentStatus).
			if (result.sideEffects !== NO_SIDE_EFFECTS) {
				deferredSideEffects.push(result.sideEffects);
			}
		}

		// Collapse consecutive session lifecycle entries (resumed/stopped) with no
		// meaningful content between them. Keep only the last one in each run.
		entries = collapseLifecycleEntries(entries);

		setLogs(entries);
		for (const fn of deferredSideEffects) fn();
		// Re-fetch real agent status after processing historical events.
		// processEvent side effects may have stale setActiveAgents calls from
		// old agent_start/agent_end events — checkAgentStatus
		// overwrites with the actual current state from the backend.
		checkAgentStatus();
	}

	/** Entry types that count as "meaningful content" — NOT lifecycle noise. */
	function isMeaningfulEntry(e: LogEntry): boolean {
		// lifecycle entries (session resumed, agent stopped) are not meaningful
		if (e.type === "lifecycle") return false;
		// All other types are meaningful content
		return true;
	}

	/**
	 * Scan entries and collapse runs of consecutive lifecycle-only entries
	 * (session resumed / agent stopped) into just the last one in each run.
	 */
	function collapseLifecycleEntries(entries: LogEntry[]): LogEntry[] {
		if (entries.length === 0) return entries;

		const result: LogEntry[] = [];
		let lastLifecycleIdx = -1; // index in result of last lifecycle entry in current run

		for (const entry of entries) {
			if (!isMeaningfulEntry(entry)) {
				// This is a lifecycle entry
				if (lastLifecycleIdx >= 0) {
					// Replace the previous lifecycle entry in the current run
					result[lastLifecycleIdx] = entry;
				} else {
					// Start a new lifecycle run
					lastLifecycleIdx = result.length;
					result.push(entry);
				}
			} else {
				// Meaningful content — break any lifecycle run
				lastLifecycleIdx = -1;
				result.push(entry);
			}
		}

		return result;
	}

	// --- Main handler ---

	function handleEvent(msg: IncomingEvent) {
		// pending_clarifications: pass-through (still ephemeral/in-memory)
		if (msg.type === "pending_clarifications") {
			setPendingClarifications(msg.clarifications);
			return;
		}

		// Agent lifecycle events update activeAgents GLOBALLY — before the per-session filter.
		// The task tree sidebar needs accurate active/idle status for ALL tasks, not just the viewed one.
		if ("taskId" in msg && msg.taskId) {
			if (msg.type === "agent_start" || msg.type === "agent_active") {
				setActiveAgents((prev) => new Set(prev).add(msg.taskId));
			} else if (msg.type === "agent_idle" || msg.type === "agent_end") {
				setActiveAgents((prev) => {
					const next = new Set(prev);
					next.delete(msg.taskId);
					return next;
				});
			}
		}

		// Filter SSE events by taskId — only process events for the currently viewed session.
		// Global events (tree_updated, pending_clarifications) have no taskId and pass through.
		const viewedId = deps.getViewedSessionId?.();
		if (viewedId && "taskId" in msg && msg.taskId && msg.taskId !== viewedId) {
			return;
		}

		// Live event: process through the unified path
		const result = processEvent(msg);
		if (result.entries.length > 0) {
			setLogs((prev) => [...prev, ...result.entries]);
		}
		for (const op of result.updates) {
			setLogs((prev) => applyUpdate(prev, op));
		}
		if (result.pendingActions) {
			for (const action of result.pendingActions) dispatchPending(action);
		}
		result.sideEffects();
	}

	return { handleEvent, processEventBatch };
}
