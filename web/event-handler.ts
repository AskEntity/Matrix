import type React from "react";
import type { QueueMessage } from "../src/message-queue.ts";
import { TOOL_YIELD } from "../src/tool-names.ts";
import { ulid } from "../src/ulid.ts";
import {
	createLogEntry,
	getLogTaskId,
	type IncomingEvent,
	isTask,
	type LogEntry,
	type TreeNode,
	type UIEvent,
} from "./hooks.ts";

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
	setPendingMessages: React.Dispatch<
		React.SetStateAction<
			{
				id: string;
				taskId: string | null;
				text: string;
				timestamp: number;
				images?: Array<{ base64: string; mediaType: string }>;
			}[]
		>
	>;
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
	/** Returns the currently viewed session ID (selectedTaskId ?? rootNodeId). Used to filter SSE events. */
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
		setPendingMessages,
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

	/**
	 * Build display text for the pending message chip.
	 * User messages show their content; non-user sources show a descriptive label.
	 */
	function pendingChipText(
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

	// --- Deferred messages for two-phase lifecycle ---
	// All message events with IDs are stored here. When messages_consumed arrives,
	// they're materialized into activity log entries at the consumption position.
	// This is the SINGLE store for all deferred messages (user and non-user).
	const deferredMessages = new Map<
		string,
		{
			content: string;
			images?: Array<{ base64: string; mediaType: string }>;
			taskId?: string | null;
			ts: number;
			source?: string;
			queueEntry?: QueueMessage;
		}
	>();

	// --- Unified event processing ---

	interface ProcessResult {
		entries: LogEntry[];
		updates: UpdateOp[];
		sideEffects: () => void;
	}

	const NO_SIDE_EFFECTS = () => {};

	/** Materialize a deferred message as the appropriate LogEntry. */
	function materialize(
		msg: {
			content: string;
			images?: Array<{ base64: string; mediaType: string }>;
			taskId?: string | null;
			ts: number;
			source?: string;
			queueEntry?: QueueMessage;
		},
		ts: number,
	): LogEntry | null {
		// Non-user sources: render as the appropriate card type from body
		if (msg.queueEntry && msg.source && msg.source !== "user") {
			const uiEvent = queueEntryToUIEvent(
				msg.queueEntry,
				msg.taskId ?? undefined,
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
				id: ulid(),
				ts: Date.now(),
				content: msg.content,
				...(msg.images?.length ? { images: msg.images } : {}),
			},
			taskId: msg.taskId ?? "",
			ts,
		});
	}

	/** Sync pending banner state from the deferredMessages map. */
	function syncPendingBanner(): void {
		const pending: Array<{
			id: string;
			taskId: string | null;
			text: string;
			timestamp: number;
			images?: Array<{ base64: string; mediaType: string }>;
		}> = [];
		for (const [id, m] of deferredMessages) {
			pending.push({
				id,
				taskId: m.taskId ?? null,
				text: pendingChipText(m.source, m.content, m.queueEntry),
				timestamp: m.ts,
				images: m.images,
			});
		}
		setPendingMessages(pending);
	}

	function clearSessionState(clearedSessionIds: Set<string>): void {
		if (clearedSessionIds.size === 0) return;

		for (const [id, msg] of deferredMessages) {
			if (msg.taskId && clearedSessionIds.has(msg.taskId)) {
				deferredMessages.delete(id);
			}
		}
		syncPendingBanner();

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
								.filter(
									(node) =>
										isTask(node) && node.status === "pending" && !node.session,
								)
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
				// Persisted thinking block — replace streaming thinking with final content
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
					sideEffects: () => {
						// Compact is a reset boundary — clear all deferred messages.
						// The compact message itself (source:"compact") has an ID and gets deferred,
						// but it's filtered from nonCompact in the drain, so messages_consumed never
						// includes it. Without this clear, "[compact]" stays in the pending area forever.
						deferredMessages.clear();
						syncPendingBanner();
					},
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
					// message with id = deferred until messages_consumed.
					deferredMessages.set(umId, {
						content: umContent,
						images: umImages,
						taskId: msg.taskId,
						ts: msg.ts,
						source,
						queueEntry: body,
					});

					// Remove completed background processes immediately on receipt
					const bgCompleteId =
						body?.source === "background_complete" ? body.commandId : undefined;

					return {
						entries: [],
						updates: [],
						sideEffects: () => {
							syncPendingBanner();
							if (bgCompleteId) {
								setBackgroundProcesses((prev) => {
									const next = new Map(prev);
									next.delete(bgCompleteId);
									return next;
								});
							}
						},
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
								id: umId ?? ulid(),
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
				// Move consumed messages from pending/deferred to activity log
				const consumedIds = new Set(msg.messageIds);
				if (consumedIds.size === 0) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				const newEntries: LogEntry[] = [];

				// Materialize immediately (not as side effect) so batch mode works
				for (const id of consumedIds) {
					const deferred = deferredMessages.get(id);
					if (deferred) {
						const entry = materialize(deferred, msg.ts);
						if (entry) newEntries.push(entry);
						deferredMessages.delete(id);
					}
				}

				return {
					entries: newEntries,
					updates: [],
					// Pending banner sync is a side effect (React state update)
					sideEffects: () => syncPendingBanner(),
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
		// Clear deferred state — reprocessing from scratch
		deferredMessages.clear();
		toolCallToolNames.clear();
		setBackgroundProcesses(new Map());

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
			// Collect side effects but DON'T execute them yet.
			// For messages_consumed, processEvent puts entries directly in result.entries
			// and syncPendingBanner in sideEffects.
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
		result.sideEffects();
	}

	return { handleEvent, processEventBatch };
}
