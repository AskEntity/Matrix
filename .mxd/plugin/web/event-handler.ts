import type React from "react";
import {
	endsTurnLookingBack,
	type RunEvent,
	turnAnswersPriorWork,
} from "../run-start.ts";
import { TOOL_YIELD } from "../tool-names.ts";
// ID generation — crypto.randomUUID() for local UI state
import {
	type AgentActivity,
	bindEntryId,
	createLogEntry,
	getLogTaskId,
	type IncomingEvent,
	isTask,
	type LogEntry,
	type TreeNode,
	type UIEvent,
} from "./hooks.ts";
import type { OffChainReason, QueueMessage } from "./types.ts";

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
	/** JSONL event ID — needed for rollback button on user messages. */
	eid?: string;
	/**
	 * Why this message is not part of the conversation, when it isn't —
	 * marked by the server on the raw-file fetch ("Load earlier history").
	 * Absent on every other path, where events are on the chain by
	 * construction.
	 */
	offChain?: OffChainReason;
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
		// compact, compacted_resume & interrupt: server-internal messages,
		// not user-pending. Each has its own display path — the
		// compact-marker / compact-summary cards, and a lifecycle line for
		// interrupt. Excluding them here means no "[compacted_resume]" chip
		// flashes during the brief emit→consume window.
		//
		// ⚠️ For `interrupt` the exclusion is not cosmetic. A chip is cleared
		// by `messages_consumed`, and the interrupt notice is deliberately
		// never consumed — that is what makes it survive as the marker the
		// launch predicate reads. A chip for it would never clear.
		if (
			!e.id ||
			source === "compact" ||
			source === "compacted_resume" ||
			source === "interrupt"
		)
			return state;
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
				eid: e.eid,
				offChain: (e as { offChain?: OffChainReason }).offChain,
			},
		];
	}
	if (e.type === "messages_consumed" && e.messageIds?.length) {
		const consumed = new Set(e.messageIds);
		return state.filter((m) => !consumed.has(m.id));
	}
	return state;
}

// ── Agent activity: pushed state, never reconstructed ──
//
// Pending (above) and activity look superficially alike and are opposites.
// Pending is a PROJECTION of a persistent log — replaying the log rebuilds it
// exactly, so a reducer over events is the right shape. Activity is LIVE
// PROCESS STATE with no persistent representation at all: the log can only
// say "it became active at some past instant", and replaying that as "it is
// active now" is a category error. That error is what the previous design
// made, and what it then needed a status poll to undo after every batch.
//
// So the map here is fed by exactly one thing — `agent_activity` /
// `agent_activity_snapshot`, both ephemeral, neither ever written to JSONL.
// Historical events cannot reach this reducer, which makes "replay must not
// fake-activate" structurally true instead of corrected after the fact.
//
// A task with NO entry has no agent. That is deliberately different from
// `idle`, which means the loop is alive and waiting for input.

/** taskId → what that task's agent is doing. Absent = no agent at all. */
export type ActivityMap = Readonly<Record<string, AgentActivity>>;

export type ActivityAction =
	/** Full replacement — the connect-time snapshot. Empty is meaningful. */
	| { type: "RESET"; states: Record<string, AgentActivity> }
	/** One task changed. `state: null` = its session ended. */
	| { type: "SET"; taskId: string; state: AgentActivity | null };

export function activityReducer(
	state: ActivityMap,
	action: ActivityAction,
): ActivityMap {
	if (action.type === "RESET") return { ...action.states };
	const next = { ...state };
	if (action.state === null) delete next[action.taskId];
	else next[action.taskId] = action.state;
	return next;
}

// `isWorking` — the ONE derivation of "active", shared by spinners, tab
// indicators, the task tree AND the backend's edit gate — moved to
// `../agent-activity.ts` when the gate needed it. Imported above.

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
			/**
			 * The persisted block's eid. The entry usually already exists —
			 * `text_delta` built it before this event was written — so this
			 * BINDS the eid to the id that entry already has, instead of
			 * deriving a new one. That is what keeps the key stable across
			 * the moment a streamed block closes.
			 */
			eid?: string;
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
			/** See replace_text.eid. */
			eid?: string;
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
			/** eid of the compact_marker this entry stands for. */
			eid?: string;
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
			/**
			 * eid of the tool_result. Only used when no tool_call is found —
			 * a resolved pair keeps the tool_call's eid, because the pair IS
			 * that entry with its result filled in.
			 */
			eid?: string;
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
	/**
	 * Apply an activity action. Like dispatchPending, the consumer writes
	 * through to a ref synchronously before triggering a re-render, so a
	 * follow-up event in the same tick reads the already-applied map.
	 */
	dispatchActivity: (action: ActivityAction) => void;
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
		dispatchActivity,
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
	 * Message IDs consumed in the most recent `processEventBatch` run.
	 *
	 * After a batch fetch (page load / SSE reconnect), `processEventBatch`
	 * does RESET + full replay from JSONL — pending is correctly rebuilt.
	 * But SSE ring-buffer catch-up events can arrive AFTER the batch and
	 * re-add `message` events whose `messages_consumed` was already
	 * processed in the batch. Without this guard the pending chip
	 * reappears (and its SSE `messages_consumed` is either a no-op
	 * on an empty pending, or never arrives if the catch-up window
	 * didn't include it).
	 *
	 * `handleEvent` checks this set before dispatching APPLY(message)
	 * for `message` events — if the id was already consumed in the last
	 * batch, the pending action is suppressed.
	 *
	 * Cleared on every `processEventBatch` RESET (fresh derivation).
	 */
	const batchConsumedIds = new Set<string>();

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
			case "interrupt":
				// "The user cut off your previous message." Written by the
				// provider loop at the park, never consumed.
				//
				// Rendered as a lifecycle line rather than a message card
				// because it is not something anyone sent — it is the log
				// saying why the assistant text above it stops mid-word. Live,
				// the user already saw a transient "Interrupted by user"
				// status, which is broadcast-only and gone after a refresh;
				// this is the durable half of the same fact.
				return {
					type: "lifecycle",
					content: "⏸ Interrupted by user",
					taskId: parentTaskId,
					ts: eventTs,
				};
			case "compacted_resume":
				// Post-compact summary injected as a "message" event — the
				// agent's memory of the erased conversation. Rendered as its
				// own compact-summary card by LogEntryView (near the
				// compact_marker bar). Without this case the summary would
				// never reach the activity log.
				return {
					type: "message",
					id: qe.id,
					body: {
						source: "compacted_resume",
						id: qe.id,
						ts: qe.ts ?? eventTs,
						content: qe.content,
					},
					taskId: parentTaskId ?? "",
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
			return uiEvent
				? createLogEntry({
						...uiEvent,
						...(p.eid ? { eid: p.eid } : {}),
						...(p.offChain ? { offChain: p.offChain } : {}),
					})
				: null;
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
			...(p.eid ? { eid: p.eid } : {}),
			...(p.offChain ? { offChain: p.offChain } : {}),
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
	 * Events since the last turn boundary, per task — the current user turn as
	 * it is being built. Reading them in order is how "was this message sent
	 * on its own" gets answered without a second pass over the log, which is
	 * what let the live path answer it at all: it sees one event at a time and
	 * never has the whole batch.
	 */
	const turnWindows = new Map<string, RunEvent[]>();

	/**
	 * Feed one event to the per-task turn tracker, and return the turn it
	 * closes. Only a boundary event closes a turn; for anything else the
	 * return value is not meaningful (the event has just been added to the
	 * window it would be describing).
	 *
	 * Events the server marked as off the active chain are ignored entirely.
	 * The raw file interleaves abandoned branches with the conversation, and a
	 * tool call from a branch nobody is on must not count against a message
	 * that has nothing to do with it. Dropping them leaves exactly the active
	 * chain, in order — the same sequence a chain-walked fetch would deliver.
	 */
	function noteTurnEvent(msg: IncomingEvent): RunEvent[] {
		if ((msg as { offChain?: OffChainReason }).offChain) return [];
		const taskId =
			"taskId" in msg && typeof msg.taskId === "string" ? msg.taskId : "";
		const current = turnWindows.get(taskId) ?? [];
		if (endsTurnLookingBack(msg.type)) {
			turnWindows.set(taskId, []);
			return current;
		}
		current.push(msg as unknown as RunEvent);
		turnWindows.set(taskId, current);
		return current;
	}

	/**
	 * Single event → entries, in-place updates, and side effects.
	 * THE unified event processor — used by both live SSE and batch processing.
	 * Accepts typed IncomingEvent — discriminated union narrowing eliminates all `as` casts.
	 */
	function processEvent(msg: IncomingEvent): ProcessResult {
		// Both callers reach this one function in event order, which is why
		// the turn tracker lives here: annotate once, and live and refetched
		// entries get the same answer from the same rule.
		const closedTurn = noteTurnEvent(msg);

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

			// SSE-only events that processEvent doesn't handle. The two
			// activity events are consumed by handleEvent before the
			// viewed-session filter (activity is project-wide) and are listed
			// here only so this switch stays exhaustive.
			case "pending_clarifications":
			case "agent_activity":
			case "agent_activity_snapshot":
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
							eid: msg.eid,
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
							eid: msg.eid,
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
							eid: msg.eid,
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
							eid: msg.eid,
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
							eid: msg.eid,
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
							eid: msg.eid,
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
							eid: msg.eid,
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
				// No log entry. The event is still emitted, persisted and
				// processed — only its rendered line is gone. `▶ Agent started`
				// used to mean "the daemon restarted and this agent came back",
				// and it stopped meaning that once an agent was only launched
				// when work was outstanding: the cause is now overwhelmingly a
				// message, which is rendered immediately below it anyway.
				return {
					entries: [],
					updates: [],
					// Lifecycle events report which provider/model a run used —
					// they no longer say anything about activity. Deriving
					// "running" from agent_start was one of the three competing
					// sources, and the one that made replaying history light the
					// UI up for agents that died long ago.
					sideEffects: () => {
						if (msg.provider) setAgentProvider(msg.provider);
						if (msg.model) setAgentModel(msg.model);
					},
				};
			}

			case "agent_end": {
				// No log entry — see agent_start. The stats below are the whole
				// reason this case still exists: they are what the token badge
				// reads.
				return {
					entries: [],
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
					},
				};
			}

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

					// interrupt: the loop's own note that a turn was cut off.
					//
					// ⚠️ It MUST skip pending, and this is the one source where
					// skipping is load-bearing rather than tidy. A pending chip
					// is cleared by `messages_consumed`, and this message is
					// deliberately never consumed — that is exactly what makes
					// it visible to the launch predicate on the next boot. Route
					// it through pending and the chip has nothing that can ever
					// clear it, so it sits in the UI forever.
					if (source === "interrupt" && body) {
						const uiEvent = queueEntryToUIEvent(
							body,
							msg.taskId ?? undefined,
							msg.ts,
						);
						return {
							entries: uiEvent
								? [createLogEntry({ ...uiEvent, eid: msg.eid })]
								: [],
							updates: [],
							sideEffects: NO_SIDE_EFFECTS,
						};
					}

					// compacted_resume: server-injected post-compact summary.
					// Render directly as its own log entry (compact summary
					// card) rather than going through pending. Skipping
					// pending mirrors `compact` above — compacted_resume is
					// not a user-pending message; it's the agent's memory
					// of the erased conversation.
					if (source === "compacted_resume" && body) {
						const uiEvent = queueEntryToUIEvent(
							body,
							msg.taskId ?? undefined,
							msg.ts,
						);
						if (uiEvent) {
							return {
								entries: [createLogEntry({ ...uiEvent, eid: msg.eid })],
								updates: [],
								sideEffects: NO_SIDE_EFFECTS,
							};
						}
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
							entries: [createLogEntry({ ...uiEvent, eid: msg.eid })],
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
							eid: msg.eid,
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
				// This is the moment the question becomes answerable: a turn
				// carrying a tool_result is answering the agent's own previous
				// output, so nothing riding along in it started anything.
				// Delivery order decides, and this is delivery order — the
				// entries are not, since a message typed mid-tool-call renders
				// after the finished tool card.
				//
				// A consumption on an abandoned branch says nothing about the
				// conversation, and the messages it names are refused for
				// being off-chain anyway — a stronger and more specific answer
				// than anything this could add.
				const startsRun = (msg as { offChain?: OffChainReason }).offChain
					? undefined
					: !turnAnswersPriorWork(closedTurn);
				const newEntries: LogEntry[] = [];
				for (const p of getPendingMessages()) {
					if (consumedIds.has(p.id)) {
						const entry = materializeFromPending(p, msg.ts);
						if (entry)
							newEntries.push(
								startsRun === undefined ? entry : { ...entry, startsRun },
							);
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
							eid: msg.eid,
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
						// The block closing gives this entry its durable name. Bind
						// rather than re-derive: the entry already has an id, and
						// changing it here would remount it at the end of every
						// streamed block.
						if (op.eid) bindEntryId(op.eid, e.id);
						// Use persisted event's ts so refresh matches JSONL reconstruction
						updated[i] = {
							...e,
							content: op.text,
							ts: op.ts ?? e.ts,
							...(op.eid ? { eid: op.eid } : {}),
						};
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
						eid: op.eid,
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
						// See replace_text: bind, don't re-derive.
						if (op.eid) bindEntryId(op.eid, e.id);
						updated[i] = {
							...e,
							thinking: op.text,
							signature: op.signature,
							// Use persisted event's ts so refresh matches JSONL reconstruction
							ts: op.ts ?? e.ts,
							...(op.eid ? { eid: op.eid } : {}),
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
						eid: op.eid,
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
					eid: op.eid,
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
						// Same entry, now with its result — so it keeps its id and
						// its eid (the tool_call's). Handing it a fresh id would
						// remount the card the instant the result lands, which is
						// exactly when a user might have it expanded to watch.
						updated[i] = createLogEntry(
							{
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
								eid: e.eid,
							},
							e.id,
						);
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
						eid: op.eid,
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
	 *
	 * Takes no "is this the conversation" flag any more. It used to, because
	 * "Load earlier history" hands back the raw file — abandoned rewind
	 * branches and summarized-away history included — and the client had no
	 * way to tell those apart, so it declined to judge that batch at all. The
	 * server marks them now (`offChain`), which is a real answer rather than
	 * a refusal to answer, so every batch is treated the same way and the
	 * events that are not part of the conversation say so for themselves.
	 */
	function processEventBatch(events: IncomingEvent[]): void {
		// Reset per-batch state — reprocessing from scratch. Pending reducer
		// also resets to []; message events in the batch will re-populate it.
		toolCallToolNames.clear();
		turnWindows.clear();
		setBackgroundProcesses(new Map());
		dispatchPending({ type: "RESET" });

		// Collect consumed IDs from this batch so handleEvent can suppress
		// stale SSE catch-up `message` events that arrive after this batch
		// (see batchConsumedIds declaration for the full race description).
		batchConsumedIds.clear();
		for (const evt of events) {
			if (evt.type === "messages_consumed" && evt.messageIds) {
				for (const id of evt.messageIds) batchConsumedIds.add(id);
			}
		}

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

		setLogs(entries);
		for (const fn of deferredSideEffects) fn();
		// No status re-fetch here any more. This used to end with
		// `checkAgentStatus()` because replaying historical agent_start events
		// left the UI believing dead agents were running, and something had to
		// overwrite that. Nothing in this batch can touch activity now — it
		// comes only from ephemeral events that never enter JSONL — so there
		// is nothing to correct.
	}

	// A `collapseLifecycleEntries` pass used to run over `entries` here,
	// folding runs of consecutive lifecycle entries down to the last one. It
	// existed because a restart wrote `▶ Agent started` / `⏹ Agent stopped`
	// pairs with nothing between them, and a dormant session rendered dozens
	// of them in a row. Those two lines are gone, so its premise is gone; the
	// only lifecycle entry left is the interrupt notice, and one cannot follow
	// another — the notice is written AT the park, so a second one needs the
	// agent to have woken, which needs a message, which renders and breaks the
	// run. Do not restore it for a new lifecycle producer either: it replaced
	// in place (`result[first] = last`), so two distinct entries came out as
	// one, carrying the last one's content at the first one's timestamp.

	// --- Main handler ---

	function handleEvent(msg: IncomingEvent) {
		// pending_clarifications: pass-through (still ephemeral/in-memory)
		if (msg.type === "pending_clarifications") {
			setPendingClarifications(msg.clarifications);
			return;
		}

		// Activity is project-wide, not per-session: the sidebar shows a
		// spinner for every task, so these must be handled BEFORE the
		// viewed-session filter below and never produce log entries.
		if (msg.type === "agent_activity_snapshot") {
			dispatchActivity({ type: "RESET", states: msg.states });
			return;
		}
		if (msg.type === "agent_activity") {
			dispatchActivity({
				type: "SET",
				taskId: msg.taskId,
				state: msg.state,
			});
			// This used to re-fetch the whole JSONL when the viewed agent
			// stopped, because a broadcast event carried no eid and the
			// Edit/Rewind buttons had nothing to point at. Events carry their
			// eid on every path now, and run starts are decided as events
			// arrive, so there is nothing left to go and get — and the
			// re-fetch was not free: it replaced the entire log, which is how
			// a user watching a finished run got thrown to the top of it.
			return;
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
			for (const action of result.pendingActions) {
				// Suppress stale SSE catch-up: if this is a `message` event
				// whose id was already consumed in the last batch, don't
				// re-add it to pending. The batch's RESET + rebuild already
				// handled it correctly — re-adding it here would make the
				// pending chip reappear with no subsequent messages_consumed
				// to clear it (since that was already in the batch too).
				if (
					action.type === "APPLY" &&
					action.event.type === "message" &&
					action.event.id &&
					batchConsumedIds.has(action.event.id)
				) {
					continue;
				}
				// A live messages_consumed clears the id from the guard set
				// so that genuinely new messages with recycled IDs (shouldn't
				// happen with ULIDs, but defensive) aren't permanently blocked.
				if (
					action.type === "APPLY" &&
					action.event.type === "messages_consumed" &&
					action.event.messageIds
				) {
					for (const id of action.event.messageIds) {
						batchConsumedIds.delete(id);
					}
				}
				dispatchPending(action);
			}
		}
		result.sideEffects();
	}

	return { handleEvent, processEventBatch };
}
