import type React from "react";
import type { QueueMessage } from "../src/message-queue.ts";
import {
	createLogEntry,
	getLogTaskId,
	type IncomingEvent,
	type LogEntry,
	type TaskNode,
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
			type: "complete_compact";
			text: string;
			checkpoint: string;
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
	  };

export interface EventHandlerDeps {
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
}

export function createEventHandler(deps: EventHandlerDeps) {
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
			case "child_complete":
				// Render as task_completed card at consumption time
				return {
					type: "task_completed",
					taskId: parentTaskId,
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
						content: qe.content,
						...(qe.images?.length ? { images: qe.images } : {}),
					},
					taskId: parentTaskId ?? "",
					ts: eventTs,
				};
			case "parent_update":
				return {
					type: "parent_update",
					content: qe.content,
					taskId: parentTaskId,
					ts: eventTs,
				};
			case "child_report":
				return {
					type: qe.forwarded ? "user_message_forwarded" : "child_report",
					taskId: parentTaskId,
					title: qe.title,
					summary: qe.summary ?? "",
					content: qe.content,
					...(qe.requestReply ? { requestReply: true } : {}),
					ts: eventTs,
				};
			case "background_complete":
				return {
					type: "background_complete",
					command: qe.command,
					commandId: qe.commandId,
					exitCode: qe.exitCode,
					durationMs: qe.durationMs,
					stdout: qe.stdout,
					stderr: qe.stderr,
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
			case "child_report": {
				if (queueEntry.forwarded) {
					return `📨 ${queueEntry.title}: ${queueEntry.content}`;
				}
				if (queueEntry.summary) return `↑ ${queueEntry.summary}`;
				return queueEntry.title
					? `↑ ${queueEntry.title}: ${queueEntry.content}`
					: `↑ ${queueEntry.content}`;
			}
			case "child_complete":
				return `${queueEntry.success ? "✓" : "✗"} ${queueEntry.title}`;
			case "parent_update":
				return `← Parent: ${queueEntry.content}`;
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
				if (trTool === "mcp__opengraft__yield") {
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
								const bgId = msg.backgroundId!;
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
					updates: [],
					sideEffects: () => {
						const usageKey = msg.taskId || "orchestrator";
						setTokenUsage((prev) => ({
							...prev,
							[usageKey]: {
								inputTokens: msg.inputTokens,
								contextWindow: msg.contextWindow,
								estimated: msg.estimated || false,
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
							checkpoint: msg.checkpoint,
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

			case "orchestration_started": {
				const entries: LogEntry[] = [];
				if (msg.resume) {
					entries.push(
						createLogEntry({
							type: "lifecycle",
							content: "↻ Session resumed",
							taskId: msg.taskId,
							ts: msg.ts,
						}),
					);
				}
				// prompt field removed from orchestration_started — messages are now
				// delivered via queue with unified schema and displayed via two-phase lifecycle
				return {
					entries,
					updates: [],
					sideEffects: () => {
						if (msg.taskId) {
							setRootNodeId(msg.taskId);
							setActiveAgents((prev) => new Set(prev).add(msg.taskId));
						}
						if (msg.provider) setAgentProvider(msg.provider);
						if (msg.model) setAgentModel(msg.model);
					},
				};
			}

			case "orchestration_completed":
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						if (msg.turns !== undefined) setLastTurns(msg.turns);
						if (msg.inputTokens !== undefined)
							setLastInputTokens(msg.inputTokens);
						if (msg.cacheCreationTokens !== undefined)
							setLastCacheCreationTokens(msg.cacheCreationTokens);
						if (msg.cacheReadTokens !== undefined)
							setLastCacheReadTokens(msg.cacheReadTokens);
						if (msg.outputTokens !== undefined)
							setLastOutputTokens(msg.outputTokens);
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

			case "agent_stopped":
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
						checkAgentStatus();
					},
				};

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

			case "task_started":
				// Only show in the child task's own view — parent sees it via
				// queue message two-phase lifecycle (pending → consumed)
				return {
					entries: [
						createLogEntry({
							type: "task_started",
							taskId: msg.taskId,
							title: msg.title,
							ts: msg.ts,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "task_completed":
				// UIOnlyEvent — materialized from child_complete queue messages
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			case "compacted_resume":
				// Internal compaction state — not user content
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			case "message": {
				const { body } = msg;
				const source = body?.source;
				const umId = msg.id || undefined;
				const umContent =
					body && (body.source === "user" || body.source === "parent_update")
						? body.content
						: "";
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
						updated[i] = { ...e, content: op.text };
						return updated;
					}
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
			case "complete_compact": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "compact_started") {
						const updated = [...entries];
						const replacement = createLogEntry({
							type: "compact_marker",
							checkpoint: op.checkpoint,
							savedTokens: op.savedTokens,
							taskId: op.taskId ?? "",
							ts: op.ts ?? Date.now(),
						});
						// Preserve the original entry's timestamp
						(replacement as { ts: number }).ts = e.ts;
						updated[i] = replacement;
						return updated;
					}
				}
				return [
					...entries,
					createLogEntry({
						type: "compact_marker",
						checkpoint: op.checkpoint,
						savedTokens: op.savedTokens,
						taskId: op.taskId ?? "",
						ts: op.ts ?? Date.now(),
					}),
				];
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
			// Skip provider-internal prompt events (message with empty id) and compacted_resume
			if (evt.type === "message" && !evt.id) {
				continue;
			}
			if (evt.type === "compacted_resume") {
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

		setLogs(entries);
		for (const fn of deferredSideEffects) fn();
	}

	// --- Main handler ---

	function handleEvent(msg: IncomingEvent) {
		// pending_clarifications: pass-through (still ephemeral/in-memory)
		if (msg.type === "pending_clarifications") {
			setPendingClarifications(msg.clarifications);
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
