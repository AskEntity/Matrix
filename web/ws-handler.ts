import type React from "react";
import {
	createLogEntry,
	getLogTaskId,
	type LogEntry,
	type TaskNode,
	type UIEvent,
} from "./hooks.ts";

// --- Update operations for in-place entry mutations ---

type UpdateOp =
	| { type: "merge_text"; taskId: string | undefined; text: string }
	| { type: "replace_text"; taskId: string | undefined; text: string }
	| {
			type: "complete_compact";
			text: string;
			checkpoint: string;
			savedTokens: number;
			taskId: string | undefined;
	  };

export interface WSHandlerDeps {
	updateFromWS: (nodes: TaskNode[]) => void;
	setRootNodeId: React.Dispatch<React.SetStateAction<string | null>>;
	setActiveAgents: React.Dispatch<React.SetStateAction<Set<string>>>;
	/** Re-check actual agent status from backend (GET /projects/:id/agent). */
	checkAgentStatus: () => void;
	setAgentProvider: (provider: string) => void;
	setAgentModel: (model: string) => void;
	setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
	setTokenUsage: React.Dispatch<
		React.SetStateAction<
			Record<
				string,
				{ inputTokens: number; contextWindow: number; estimated?: boolean }
			>
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
	nodeMapRef: React.MutableRefObject<Map<string, TaskNode>>;
	t: (key: string, params?: Record<string, string>) => string;
}

export function createWSHandler(deps: WSHandlerDeps) {
	const {
		updateFromWS,
		setRootNodeId,
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
		nodeMapRef,
	} = deps;

	/** Shape of a QueueEntry / rawMessage — shared by both formats. */
	interface QueueEntryLike {
		source: string;
		content?: string;
		images?: Array<{ base64: string; mediaType: string }>;
		taskId?: string;
		title?: string;
		success?: boolean;
		output?: string;
		requestReply?: boolean;
		answer?: string;
		fromProjectId?: string;
		fromProjectName?: string;
		command?: string;
		commandId?: string;
		exitCode?: number | null;
		durationMs?: number;
	}

	/**
	 * Convert a QueueEntry (or rawMessage) into a UIEvent for rendering.
	 * Works for both live WS rawMessages AND JSONL queueEntry fields.
	 * Returns null for sources that should be skipped.
	 */
	function queueEntryToUIEvent(
		qe: QueueEntryLike,
		parentTaskId?: string,
		ts?: number,
	): UIEvent | null {
		const eventTs = ts ?? Date.now();
		switch (qe.source) {
			// These don't show as separate log entries in the activity log
			case "child_complete":
			case "system":
			case "compact":
				return null;
			case "user":
				// User messages use the two-phase lifecycle (pending → consumed)
				// When called from materialization, we DO want to show them
				return {
					type: "user_message",
					content: qe.content ?? "",
					...(qe.images?.length ? { images: qe.images } : {}),
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			case "parent_update":
				return {
					type: "parent_update",
					content: qe.content ?? "",
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			case "child_report":
				return {
					type: "child_report",
					taskId: qe.taskId ?? "",
					title: qe.title ?? "",
					content: qe.content ?? "",
					...(qe.requestReply ? { requestReply: true } : {}),
					ts: eventTs,
				} as UIEvent;
			case "background_complete":
				return {
					type: "background_complete",
					command: qe.command ?? "",
					commandId: qe.commandId ?? "",
					exitCode: qe.exitCode ?? null,
					durationMs: qe.durationMs ?? 0,
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			case "cross_project":
				return {
					type: "cross_project",
					fromProjectId: qe.fromProjectId ?? "",
					fromProjectName: qe.fromProjectName ?? "",
					content: qe.content ?? "",
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			case "clarify_response":
				return {
					type: "clarify_response",
					answer: qe.answer ?? qe.content ?? "",
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			default:
				return {
					type: "generic_queue_message",
					content: qe.content ?? "",
					source: qe.source,
					taskId: parentTaskId,
					ts: eventTs,
				};
		}
	}

	/**
	 * Build display text for the pending message chip.
	 * User messages show their content; non-user sources show a descriptive label.
	 */
	function pendingChipText(
		source: string | undefined,
		content: string,
		queueEntry?: QueueEntryLike,
	): string {
		if (!source || source === "user") return content;
		switch (source) {
			case "child_report": {
				const title = queueEntry?.title;
				const body = queueEntry?.content ?? content;
				return title ? `↑ ${title}: ${body}` : `↑ ${body}`;
			}
			case "child_complete": {
				const title = queueEntry?.title ?? "";
				const ok = queueEntry?.success ? "✓" : "✗";
				return `${ok} ${title}`;
			}
			case "parent_update":
				return `← Parent: ${queueEntry?.content ?? content}`;
			case "clarify_response":
				return `💬 ${queueEntry?.answer ?? content}`;
			case "cross_project": {
				const name = queueEntry?.fromProjectName ?? "";
				return `← ${name}: ${queueEntry?.content ?? content}`;
			}
			case "background_complete":
				return `⚙ bg: ${queueEntry?.command ?? "done"}`;
			default:
				return content || `[${source}]`;
		}
	}

	/**
	 * Convert a raw queue message into a UIEvent.
	 * Maps structured rawMessage fields directly to concrete Event types.
	 * Returns null for messages that should be skipped (child_complete, system_notification).
	 */
	function createQueueUIEvent(
		rm: QueueEntryLike,
		parentTaskId?: string,
	): UIEvent | null {
		// For live WS queue_message events: skip child_complete, system, user
		// (user messages use two-phase lifecycle, child_complete/system are handled elsewhere)
		if (
			rm.source === "child_complete" ||
			rm.source === "system" ||
			rm.source === "user"
		)
			return null;
		return queueEntryToUIEvent(rm, parentTaskId);
	}

	// --- Deferred non-user queue messages (for two-phase lifecycle) ---
	// Non-user messages (child_report, parent_update, etc.) with IDs are deferred
	// until messages_consumed. They should NOT appear in the pending banner (user-facing).
	// This internal map stores them for materialization at consumption time.
	const deferredQueueMsgs = new Map<
		string,
		{
			queueEntry: QueueEntryLike;
			taskId?: string;
			ts: number;
		}
	>();

	// --- Deferred user messages (for two-phase lifecycle) ---
	// All user_message events with IDs are stored here so messages_consumed can
	// retrieve the content even after pending_messages:[] clears the React state.
	// The pending_messages banner (queue-driven) can clear before messages_consumed
	// arrives, so we need a separate store that survives that clearing.
	const deferredUserMsgs = new Map<
		string,
		{
			content: string;
			images?: Array<{ base64: string; mediaType: string }>;
			taskId?: string | null;
			ts: number;
		}
	>();

	// --- Unified event processing ---

	interface ProcessResult {
		entries: LogEntry[];
		updates: UpdateOp[];
		sideEffects: () => void;
	}

	const NO_SIDE_EFFECTS = () => {};

	/**
	 * Single event → entries, in-place updates, and side effects.
	 * Used by both batch processing (REST-fetched events) and live WS events.
	 */
	function processEvent(msg: Record<string, unknown>): ProcessResult {
		switch (msg.type) {
			case "tree_updated":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						updateFromWS(msg.nodes as TaskNode[]);
						if (msg.rootNodeId) setRootNodeId(msg.rootNodeId as string);
					},
				};

			// --- Provider events (flat, from BroadcastEvent) ---

			case "tool_call":
				return {
					entries: [
						createLogEntry({
							type: "tool_call",
							tool: msg.tool as string,
							toolCallId:
								(msg.toolCallId as string) || (msg.toolUseId as string) || "",
							input: (msg.input as Record<string, unknown>) ?? {},
							taskId: msg.taskId as string,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "tool_result":
				return {
					entries: [
						createLogEntry({
							type: "tool_result",
							tool: msg.tool as string,
							toolCallId:
								(msg.toolCallId as string) || (msg.toolUseId as string) || "",
							content: (msg.content as string) || "",
							isError: (msg.isError as boolean) || false,
							images: msg.images as
								| Array<{ base64: string; mediaType: string }>
								| undefined,
							taskId: msg.taskId as string,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "text_delta": {
				const deltaText = (msg.content as string) || "";
				if (!deltaText) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				return {
					entries: [],
					updates: [
						{
							type: "merge_text",
							taskId: msg.taskId as string | undefined,
							text: deltaText,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "assistant_text": {
				const fullText = (msg.content as string) || "";
				if (!fullText) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				return {
					entries: [],
					updates: [
						{
							type: "replace_text",
							taskId: msg.taskId as string | undefined,
							text: fullText,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "usage":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						const usageKey =
							(msg.taskId as string | undefined) ?? "orchestrator";
						setTokenUsage((prev) => ({
							...prev,
							[usageKey]: {
								inputTokens: msg.inputTokens as number,
								contextWindow: msg.contextWindow as number,
								estimated: (msg.estimated as boolean) || false,
							},
						}));
					},
				};

			case "compact_started":
				return {
					entries: [
						createLogEntry({
							type: "compact_started",
							taskId: msg.taskId as string,
							ts: (msg.ts as number) ?? Date.now(),
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
							checkpoint: msg.checkpoint as string,
							savedTokens: (msg.savedTokens as number) ?? 0,
							taskId: msg.taskId as string | undefined,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "queue_message": {
				const entries: LogEntry[] = [];
				const rawMessages = msg.rawMessages as
					| Array<Record<string, unknown>>
					| undefined;
				if (rawMessages && rawMessages.length > 0) {
					for (const rm of rawMessages) {
						const event = createQueueUIEvent(
							rm as unknown as QueueEntryLike,
							msg.taskId as string | undefined,
						);
						if (event) entries.push(createLogEntry(event));
					}
				} else {
					const raw = (msg.messages as string) || "";
					if (raw) {
						entries.push(
							createLogEntry({
								type: "generic_queue_message",
								content: raw,
								taskId: msg.taskId as string | undefined,
								ts: (msg.ts as number) ?? Date.now(),
							}),
						);
					}
				}
				return { entries, updates: [], sideEffects: NO_SIDE_EFFECTS };
			}

			case "status":
				// Status events are internal — no log entries
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			// --- Lifecycle events ---

			case "orchestration_started": {
				const startRootId = msg.taskId as string | undefined;
				const entries: LogEntry[] = [];
				if (msg.resume) {
					entries.push(
						createLogEntry({
							type: "lifecycle",
							content: "↻ Session resumed",
							taskId: startRootId,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					);
				}
				if (msg.prompt) {
					entries.push(
						createLogEntry({
							type: "user_message",
							content: msg.prompt as string,
							taskId: startRootId,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					);
				}
				return {
					entries,
					updates: [],
					sideEffects: () => {
						if (startRootId) {
							setRootNodeId(startRootId);
							setActiveAgents((prev) => new Set(prev).add(startRootId));
						}
						if (msg.provider) setAgentProvider(msg.provider as string);
						if (msg.model) setAgentModel(msg.model as string);
					},
				};
			}

			case "orchestration_completed":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						if (msg.turns !== undefined) setLastTurns(msg.turns as number);
						if (msg.inputTokens !== undefined)
							setLastInputTokens(msg.inputTokens as number);
						if (msg.cacheCreationTokens !== undefined)
							setLastCacheCreationTokens(msg.cacheCreationTokens as number);
						if (msg.cacheReadTokens !== undefined)
							setLastCacheReadTokens(msg.cacheReadTokens as number);
						if (msg.outputTokens !== undefined)
							setLastOutputTokens(msg.outputTokens as number);
						if (msg.taskId) {
							setActiveAgents((prev) => {
								const next = new Set(prev);
								next.delete(msg.taskId as string);
								return next;
							});
						}
						checkAgentStatus();
					},
				};

			case "agent_stopped":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						if (msg.taskId) {
							setActiveAgents((prev) => {
								const next = new Set(prev);
								next.delete(msg.taskId as string);
								return next;
							});
						}
						checkAgentStatus();
					},
				};

			case "agent_active":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						if (msg.taskId) {
							setActiveAgents((prev) =>
								new Set(prev).add(msg.taskId as string),
							);
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
								next.delete(msg.taskId as string);
								return next;
							});
						}
					},
				};

			case "task_started": {
				const startedParentId =
					nodeMapRef.current.get(msg.taskId as string)?.parentId ?? undefined;
				const ts = (msg.ts as number) ?? Date.now();
				const entries = [
					createLogEntry({
						type: "task_started",
						taskId: msg.taskId as string,
						title: msg.title as string,
						ts,
					}),
				];
				if (startedParentId) {
					entries.push(
						createLogEntry({
							type: "task_started",
							taskId: startedParentId,
							title: msg.title as string,
							ts,
						}),
					);
				}

				return { entries, updates: [], sideEffects: NO_SIDE_EFFECTS };
			}

			case "task_completed": {
				const completedParentId =
					nodeMapRef.current.get(msg.taskId as string)?.parentId ?? undefined;
				const ts = (msg.ts as number) ?? Date.now();
				const entries = [
					createLogEntry({
						type: "task_completed",
						taskId: msg.taskId as string,
						title: msg.title as string,
						success: msg.success as boolean,
						output: (msg.output as string) || undefined,
						ts,
					}),
				];
				if (completedParentId) {
					entries.push(
						createLogEntry({
							type: "task_completed",
							taskId: completedParentId,
							title: msg.title as string,
							success: msg.success as boolean,
							output: (msg.output as string) || undefined,
							ts,
						}),
					);
				}
				return { entries, updates: [], sideEffects: NO_SIDE_EFFECTS };
			}

			case "user_message": {
				const umId = msg.id as string | undefined;
				const queueEntry = msg.queueEntry as QueueEntryLike | undefined;
				const source = queueEntry?.source ?? (msg.source as string | undefined);
				const umTaskId = msg.taskId as string | null | undefined;
				const umTs = (msg.ts as number) ?? Date.now();

				if (umId) {
					// user_message with id = deferred until messages_consumed.
					// Show ALL sources in pending banner + store queueEntry for materialization.
					const umContent = (msg.content as string) || "";
					const umImages = msg.images as
						| Array<{ base64: string; mediaType: string }>
						| undefined;
					// Build display text for the pending chip
					const pendingText = pendingChipText(source, umContent, queueEntry);
					return {
						entries: [],
						updates: [],
						sideEffects: () => {
							setPendingMessages((prev) => [
								...prev,
								{
									id: umId,
									taskId: umTaskId ?? null,
									text: pendingText,
									timestamp: umTs,
									images: umImages,
								},
							]);
							// Store user message data in durable map so messages_consumed
							// can retrieve it even after pending_messages:[] clears React state
							deferredUserMsgs.set(umId, {
								content: umContent,
								images: umImages,
								taskId: umTaskId,
								ts: umTs,
							});
							// Also store queueEntry for non-user sources so
							// messages_consumed can materialize the correct card type
							if (queueEntry && source && source !== "user") {
								deferredQueueMsgs.set(umId, {
									queueEntry,
									taskId: umTaskId ?? undefined,
									ts: umTs,
								});
							}
						},
					};
				}

				// user_message without id = initial prompt or legacy event
				// If it has a queueEntry with non-user source, render as the appropriate card type
				if (queueEntry && source && source !== "user") {
					const uiEvent = queueEntryToUIEvent(
						queueEntry,
						umTaskId ?? undefined,
						umTs,
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
							type: "user_message",
							content: (msg.content as string) || "",
							...(msg.images
								? {
										images: msg.images as Array<{
											base64: string;
											mediaType: string;
										}>,
									}
								: {}),
							taskId: umTaskId ?? undefined,
							ts: umTs,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "messages_consumed": {
				// Move consumed messages from pending/deferred to activity log
				const consumedIds = new Set((msg.messageIds as string[]) ?? []);
				if (consumedIds.size === 0) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				const consumeTs = (msg.ts as number) ?? Date.now();
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						const newEntries: LogEntry[] = [];

						for (const id of consumedIds) {
							// 1. Check deferred non-user queue messages (child_report, parent_update, etc.)
							const deferred = deferredQueueMsgs.get(id);
							if (deferred) {
								const uiEvent = queueEntryToUIEvent(
									deferred.queueEntry,
									deferred.taskId,
									consumeTs,
								);
								if (uiEvent) {
									newEntries.push(createLogEntry(uiEvent));
								}
								deferredQueueMsgs.delete(id);
								deferredUserMsgs.delete(id);
								continue;
							}

							// 2. Check deferred user messages (stored durably, survives pending_messages clearing)
							const userMsg = deferredUserMsgs.get(id);
							if (userMsg) {
								newEntries.push(
									createLogEntry({
										type: "user_message",
										content: userMsg.content,
										...(userMsg.images?.length
											? { images: userMsg.images }
											: {}),
										taskId: userMsg.taskId ?? undefined,
										ts: consumeTs,
									}),
								);
								deferredUserMsgs.delete(id);
							}
						}

						if (newEntries.length > 0) {
							setLogs((prevLogs) => [...prevLogs, ...newEntries]);
						}

						// Clear consumed messages from pending banner (if still there)
						setPendingMessages((prev) =>
							prev.filter((p) => !consumedIds.has(p.id)),
						);
					},
				};
			}

			// Backward compat: old JSONL files may have message_injected events
			case "message_injected":
				return {
					entries: [
						createLogEntry({
							type: "user_message",
							content: (msg.message as string) || "",
							...(msg.images
								? {
										images: msg.images as Array<{
											base64: string;
											mediaType: string;
										}>,
									}
								: {}),
							taskId: msg.taskId as string | undefined,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "error":
				return {
					entries: [
						createLogEntry({
							type: "error",
							message: msg.message as string,
							taskId: msg.taskId as string | undefined,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "tree_mutation": {
				const action = msg.action as string;
				const title = (msg.title as string) || "";
				return {
					entries: [
						createLogEntry({
							type: "tree_mutation",
							action,
							nodeId: msg.nodeId as string,
							title: title || undefined,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			// Backward compat: handle old-format agent_event from persisted event history
			case "agent_event":
				return processLegacyAgentEvent(msg);

			default:
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
		}
	}

	/**
	 * Handle legacy agent_event format from persisted event history.
	 * Transforms the old wrapped format into the new flat format and re-processes.
	 */
	function processLegacyAgentEvent(
		msg: Record<string, unknown>,
	): ProcessResult {
		const et = msg.eventType as string;
		const ts = msg.ts ?? msg.timestamp ?? Date.now();

		// Map old eventType names to new flat event types
		const mapped: Record<string, unknown> = { ...msg, ts };
		switch (et) {
			case "tool_use":
				mapped.type = "tool_call";
				break;
			case "text":
				mapped.type = "assistant_text";
				break;
			case "compact":
				mapped.type = "compact_marker";
				break;
			default:
				// Most eventTypes map directly to the new type names
				mapped.type = et;
				break;
		}
		// Remove the wrapper fields
		delete mapped.eventType;
		return processEvent(mapped);
	}

	// --- Update application helpers ---

	/**
	 * Apply update operations to an entries array (batch/replay mode).
	 * Mutates the array in-place for efficiency during batch processing.
	 */
	function applyUpdateToArray(entries: LogEntry[], op: UpdateOp): void {
		switch (op.type) {
			case "merge_text": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
						entries[i] = { ...e, content: e.content + op.text };
						return;
					}
					if (e && getLogTaskId(e) === op.taskId && e.type !== "assistant_text")
						break;
				}
				// No existing text entry — create new
				entries.push(
					createLogEntry({
						type: "assistant_text",
						content: op.text,
						taskId: op.taskId ?? "",
						ts: Date.now(),
					}),
				);
				break;
			}
			case "replace_text": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
						entries[i] = { ...e, content: op.text };
						return;
					}
					if (e && getLogTaskId(e) === op.taskId && e.type !== "assistant_text")
						break;
				}
				entries.push(
					createLogEntry({
						type: "assistant_text",
						content: op.text,
						taskId: op.taskId ?? "",
						ts: Date.now(),
					}),
				);
				break;
			}
			case "complete_compact": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "compact_started") {
						// Replace compact_started with compact_marker
						const replacement = createLogEntry({
							type: "compact_marker",
							checkpoint: op.checkpoint,
							savedTokens: op.savedTokens,
							taskId: op.taskId ?? "",
							ts: Date.now(),
						});
						// Preserve the original entry's timestamp
						(replacement as { ts: number }).ts = e.ts;
						entries[i] = replacement;
						return;
					}
				}
				// No pending compact entry — create completed one
				entries.push(
					createLogEntry({
						type: "compact_marker",
						checkpoint: op.checkpoint,
						savedTokens: op.savedTokens,
						taskId: op.taskId ?? "",
						ts: Date.now(),
					}),
				);
				break;
			}
		}
	}

	/**
	 * Apply update operations via setLogs (live mode).
	 * Uses React state updater to get access to prev state.
	 */
	function applyUpdateLive(op: UpdateOp): void {
		setLogs((prev) => {
			switch (op.type) {
				case "merge_text": {
					for (let i = prev.length - 1; i >= 0; i--) {
						const e = prev[i];
						if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
							const updated = [...prev];
							updated[i] = { ...e, content: e.content + op.text };
							return updated;
						}
						if (
							e &&
							getLogTaskId(e) === op.taskId &&
							e.type !== "assistant_text"
						)
							break;
					}
					return [
						...prev,
						createLogEntry({
							type: "assistant_text",
							content: op.text,
							taskId: op.taskId ?? "",
							ts: Date.now(),
						}),
					];
				}
				case "replace_text": {
					for (let i = prev.length - 1; i >= 0; i--) {
						const e = prev[i];
						if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
							const updated = [...prev];
							updated[i] = { ...e, content: op.text };
							return updated;
						}
						if (
							e &&
							getLogTaskId(e) === op.taskId &&
							e.type !== "assistant_text"
						)
							break;
					}
					return [
						...prev,
						createLogEntry({
							type: "assistant_text",
							content: op.text,
							taskId: op.taskId ?? "",
							ts: Date.now(),
						}),
					];
				}
				case "complete_compact": {
					for (let i = prev.length - 1; i >= 0; i--) {
						const e = prev[i];
						if (e && e.type === "compact_started") {
							const updated = [...prev];
							const replacement = createLogEntry({
								type: "compact_marker",
								checkpoint: op.checkpoint,
								savedTokens: op.savedTokens,
								taskId: op.taskId ?? "",
								ts: Date.now(),
							});
							// Preserve the original entry's timestamp
							(replacement as { ts: number }).ts = e.ts;
							updated[i] = replacement;
							return updated;
						}
					}
					return [
						...prev,
						createLogEntry({
							type: "compact_marker",
							checkpoint: op.checkpoint,
							savedTokens: op.savedTokens,
							taskId: op.taskId ?? "",
							ts: Date.now(),
						}),
					];
				}
			}
		});
	}

	/**
	 * Process a batch of events into log entries (used for REST-fetched event history).
	 * Handles two-phase user message lifecycle: user_message (with id) events are held
	 * until a messages_consumed event references them, at which point they appear in the
	 * activity log at the consumption position. Unconsumed user_messages go to pending.
	 */
	function processEventBatch(events: Record<string, unknown>[]): void {
		const entries: LogEntry[] = [];
		const deferredSideEffects: (() => void)[] = [];

		// Track user_message events with IDs for two-phase resolution.
		// Stores queueEntry so we can render the correct card type at materialization.
		const pendingUserMsgs = new Map<
			string,
			{
				content: string;
				images?: Array<{ base64: string; mediaType: string }>;
				taskId?: string;
				ts: number;
				source?: string;
				queueEntry?: QueueEntryLike;
			}
		>();
		// Track which IDs have been consumed (by messages_consumed events)
		const consumedIds = new Set<string>();

		/** Materialize a deferred user_message as the appropriate LogEntry. */
		function materialize(
			userMsg: {
				content: string;
				images?: Array<{ base64: string; mediaType: string }>;
				taskId?: string;
				ts: number;
				source?: string;
				queueEntry?: QueueEntryLike;
			},
			ts: number,
		): LogEntry | null {
			// Non-user sources: render as the appropriate card type from queueEntry
			if (userMsg.queueEntry && userMsg.source && userMsg.source !== "user") {
				const uiEvent = queueEntryToUIEvent(
					userMsg.queueEntry,
					userMsg.taskId,
					ts,
				);
				return uiEvent ? createLogEntry(uiEvent) : null;
			}
			// User messages (or no source): render as user_message
			return createLogEntry({
				type: "user_message",
				content: userMsg.content,
				...(userMsg.images?.length ? { images: userMsg.images } : {}),
				taskId: userMsg.taskId,
				ts,
			});
		}

		for (const evt of events) {
			const evtType = evt.type as string;

			// Two-phase user message: collect with-id user_messages for later resolution
			if (evtType === "user_message" && evt.id) {
				const queueEntry = evt.queueEntry as QueueEntryLike | undefined;
				const source = queueEntry?.source ?? (evt.source as string | undefined);
				// For legacy events without queueEntry, build one from flat fields
				const effectiveQueueEntry: QueueEntryLike | undefined =
					queueEntry ??
					(source
						? {
								source,
								content: evt.content as string | undefined,
								taskId: evt.taskId as string | undefined,
								title: evt.title as string | undefined,
								success: evt.success as boolean | undefined,
								output: evt.output as string | undefined,
								requestReply: evt.requestReply as boolean | undefined,
								answer: evt.answer as string | undefined,
								fromProjectId: evt.fromProjectId as string | undefined,
								fromProjectName: evt.fromProjectName as string | undefined,
								command: evt.command as string | undefined,
								commandId: evt.commandId as string | undefined,
								exitCode: evt.exitCode as number | null | undefined,
								durationMs: evt.durationMs as number | undefined,
							}
						: undefined);
				pendingUserMsgs.set(evt.id as string, {
					content: (evt.content as string) || "",
					images: evt.images as
						| Array<{ base64: string; mediaType: string }>
						| undefined,
					taskId: evt.taskId as string | undefined,
					ts: (evt.ts as number) ?? Date.now(),
					source,
					queueEntry: effectiveQueueEntry,
				});
				continue;
			}

			// messages_consumed: materialize referenced user messages at this position
			if (evtType === "messages_consumed") {
				const ids = (evt.messageIds as string[]) ?? [];
				const ts = (evt.ts as number) ?? Date.now();
				for (const id of ids) {
					consumedIds.add(id);
					const userMsg = pendingUserMsgs.get(id);
					if (userMsg) {
						const entry = materialize(userMsg, ts);
						if (entry) entries.push(entry);
					}
				}
				continue;
			}

			// tool_result with messagesConsumed: materialize before the tool_result
			if (evtType === "tool_result" && evt.messagesConsumed) {
				const ids = (evt.messagesConsumed as string[]) ?? [];
				const ts = (evt.ts as number) ?? Date.now();
				for (const id of ids) {
					consumedIds.add(id);
					const userMsg = pendingUserMsgs.get(id);
					if (userMsg) {
						const entry = materialize(userMsg, ts);
						if (entry) entries.push(entry);
					}
				}
			}

			const result = processEvent(evt);
			for (const entry of result.entries) entries.push(entry);
			for (const op of result.updates) applyUpdateToArray(entries, op);
			if (result.sideEffects !== NO_SIDE_EFFECTS) {
				deferredSideEffects.push(result.sideEffects);
			}
		}

		setLogs(entries);
		for (const fn of deferredSideEffects) fn();

		// Any unconsumed user messages with IDs go to pending banner.
		// Non-user sources also stored in deferredQueueMsgs for correct materialization.
		const unconsumed: Array<{
			id: string;
			taskId: string | null;
			text: string;
			timestamp: number;
			images?: Array<{ base64: string; mediaType: string }>;
		}> = [];
		for (const [id, m] of pendingUserMsgs) {
			if (consumedIds.has(id)) continue;
			unconsumed.push({
				id,
				taskId: m.taskId ?? null,
				text: pendingChipText(m.source, m.content, m.queueEntry),
				timestamp: m.ts,
				images: m.images,
			});
			// Also store queueEntry for non-user sources
			if (m.queueEntry && m.source && m.source !== "user") {
				deferredQueueMsgs.set(id, {
					queueEntry: m.queueEntry,
					taskId: m.taskId,
					ts: m.ts,
				});
			}
		}
		if (unconsumed.length > 0) {
			setPendingMessages(unconsumed);
		}
	}

	// --- Main handler ---

	function handleWS(msg: Record<string, unknown>) {
		// pending_messages / pending_clarifications: pass-through
		if (msg.type === "pending_messages") {
			setPendingMessages(
				(msg.messages as {
					id: string;
					taskId: string | null;
					text: string;
					timestamp: number;
				}[]) ?? [],
			);
			return;
		}
		if (msg.type === "pending_clarifications") {
			setPendingClarifications(
				(msg.clarifications as {
					id: string;
					taskId: string;
					question: string;
					timestamp: number;
				}[]) ?? [],
			);
			return;
		}

		// Live event: process and apply
		const result = processEvent(msg);
		if (result.entries.length > 0) {
			setLogs((prev) => [...prev, ...result.entries]);
		}
		for (const op of result.updates) applyUpdateLive(op);
		result.sideEffects();
	}

	return { handleWS, processEventBatch };
}
