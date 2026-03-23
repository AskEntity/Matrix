import type React from "react";
import type { QueueMessage } from "../src/message-queue.ts";
import {
	createLogEntry,
	getLogTaskId,
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
				} as UIEvent;
			case "tree_change":
				return {
					type: "tree_change",
					action: qe.action,
					nodeId: qe.nodeId,
					title: qe.title,
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
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
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			case "parent_update":
				return {
					type: "parent_update",
					content: qe.content,
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			case "child_report":
				return {
					type: "child_report",
					taskId: parentTaskId,
					title: qe.title,
					summary: qe.summary ?? "",
					content: qe.content,
					...(qe.requestReply ? { requestReply: true } : {}),
					ts: eventTs,
				} as UIEvent;
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
				} as UIEvent;
			case "cross_project":
				return {
					type: "cross_project",
					fromProjectId: qe.fromProjectId,
					fromProjectName: qe.fromProjectName,
					content: qe.content,
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
			case "clarify_response":
				return {
					type: "clarify_response",
					answer: qe.answer,
					taskId: parentTaskId,
					ts: eventTs,
				} as UIEvent;
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

			// --- Provider events (flat Event types) ---

			case "tool_call": {
				const tcTool = msg.tool as string;
				const tcId = (msg.toolCallId as string) || "";
				if (tcTool && tcId) toolCallToolNames.set(tcId, tcTool);
				return {
					entries: [
						createLogEntry({
							type: "tool_call",
							tool: tcTool,
							toolCallId: tcId,
							input: (msg.input as Record<string, unknown>) ?? {},
							taskId: msg.taskId as string,
							ts: msg.ts as number,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "tool_result": {
				const bgId = msg.backgroundId as string | undefined;
				const bgCommand = msg.backgroundCommand as string | undefined;
				const trTaskId = msg.taskId as string | undefined;
				const trToolCallId = (msg.toolCallId as string) || "";
				const trTool =
					(msg.tool as string) || toolCallToolNames.get(trToolCallId) || "";
				const trContent = (msg.content as string) || "";
				const trIsError = (msg.isError as boolean) || false;
				const trImages = msg.images as
					| Array<{ base64: string; mediaType: string }>
					| undefined;
				const trPending = msg.pending as
					| {
							runningChildren: Array<{ id: string; title: string }>;
							pendingClarifications: number;
					  }
					| undefined;
				const trTs = msg.ts as number;

				// Yield tool_result: remove the tool_call entry entirely
				if (trTool === "mcp__opengraft__yield") {
					return {
						entries: [],
						updates: [{ type: "remove_tool", toolCallId: trToolCallId }],
						sideEffects: NO_SIDE_EFFECTS,
					};
				}

				// Normal tool_result: replace matching tool_call with tool_pair
				return {
					entries: [],
					updates: [
						{
							type: "resolve_tool",
							toolCallId: trToolCallId,
							tool: trTool,
							resultContent: trContent,
							isError: trIsError,
							images: trImages,
							pending: trPending,
							backgroundId: bgId,
							backgroundCommand: bgCommand,
							resultTs: trTs,
						},
					],
					sideEffects: bgId
						? () => {
								const bgStartTime = trTs;
								setBackgroundProcesses((prev) => {
									const next = new Map(prev);
									next.set(bgId, {
										id: bgId,
										command: bgCommand ?? "",
										startTime: bgStartTime,
										taskId: trTaskId,
									});
									return next;
								});
							}
						: NO_SIDE_EFFECTS,
				};
			}

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
							ts: msg.ts as number | undefined,
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
							ts: msg.ts as number | undefined,
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
							ts: msg.ts as number,
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
							savedTokens: msg.savedTokens as number,
							taskId: msg.taskId as string | undefined,
							ts: msg.ts as number | undefined,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};

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
							ts: msg.ts as number,
						}),
					);
				}
				// prompt field removed from orchestration_started — messages are now
				// delivered via queue with unified schema and displayed via two-phase lifecycle
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
				const ts = msg.ts as number;
				// Only show in the child task's own view — parent sees it via
				// queue message two-phase lifecycle (pending → consumed)
				return {
					entries: [
						createLogEntry({
							type: "task_started",
							taskId: msg.taskId as string,
							title: msg.title as string,
							ts,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "task_completed":
				// Removed — done() tool card replaces this in child view,
				// child_complete queue message handles parent view
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			case "compacted_resume":
				// Internal compaction state — not user content
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };

			case "message": {
				const body = msg.body as QueueMessage | undefined;
				const source = body?.source;
				const umId = msg.id as string | undefined;
				const umTaskId = msg.taskId as string | null | undefined;
				const umTs = msg.ts as number;
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
						taskId: umTaskId,
						ts: umTs,
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
							type: "message",
							id: umId ?? "",
							body: {
								source: "user",
								content: umContent,
								...(umImages?.length ? { images: umImages } : {}),
							},
							taskId: umTaskId ?? "",
							ts: umTs,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "messages_consumed": {
				// Move consumed messages from pending/deferred to activity log
				const consumedIds = new Set(msg.messageIds as string[]);
				if (consumedIds.size === 0) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				const consumeTs = msg.ts as number;
				const newEntries: LogEntry[] = [];

				// Materialize immediately (not as side effect) so batch mode works
				for (const id of consumedIds) {
					const deferred = deferredMessages.get(id);
					if (deferred) {
						const entry = materialize(deferred, consumeTs);
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
							message: msg.message as string,
							taskId: (msg.taskId as string) ?? "",
							ts: msg.ts as number,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			default:
				return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
		}
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
						ts: op.ts ?? Date.now(),
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
						ts: op.ts ?? Date.now(),
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
							ts: op.ts ?? Date.now(),
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
						ts: op.ts ?? Date.now(),
					}),
				);
				break;
			}
			case "resolve_tool": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "tool_call" && e.toolCallId === op.toolCallId) {
						// Replace tool_call with tool_pair
						entries[i] = createLogEntry({
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
						return;
					}
				}
				// Orphan tool_result — no matching tool_call found. Create as standalone tool_pair.
				entries.push(
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
				);
				break;
			}
			case "remove_tool": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (
						e &&
						(e.type === "tool_call" || e.type === "tool_pair") &&
						e.toolCallId === op.toolCallId
					) {
						entries.splice(i, 1);
						return;
					}
				}
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
							ts: op.ts ?? Date.now(),
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
							ts: op.ts ?? Date.now(),
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
								ts: op.ts ?? Date.now(),
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
							ts: op.ts ?? Date.now(),
						}),
					];
				}
				case "resolve_tool": {
					for (let i = prev.length - 1; i >= 0; i--) {
						const e = prev[i];
						if (e && e.type === "tool_call" && e.toolCallId === op.toolCallId) {
							const updated = [...prev];
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
						...prev,
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
					for (let i = prev.length - 1; i >= 0; i--) {
						const e = prev[i];
						if (
							e &&
							(e.type === "tool_call" || e.type === "tool_pair") &&
							e.toolCallId === op.toolCallId
						) {
							return prev.filter((_, idx) => idx !== i);
						}
					}
					return prev;
				}
			}
		});
	}

	/**
	 * Process a batch of events (used for REST-fetched event history on page load/reconnect).
	 * Resets all state and reprocesses from scratch through the unified processEvent path.
	 */
	function processEventBatch(events: Record<string, unknown>[]): void {
		// Clear deferred state — reprocessing from scratch
		deferredMessages.clear();
		toolCallToolNames.clear();
		setBackgroundProcesses(new Map());

		const entries: LogEntry[] = [];
		const deferredSideEffects: (() => void)[] = [];

		for (const evt of events) {
			// Skip provider-internal prompt events and compacted_resume
			const evtType = evt.type as string;
			if (evtType === "message" && evt.cwd && !evt.id) {
				continue;
			}
			if (evtType === "compacted_resume") {
				continue;
			}

			const result = processEvent(evt);
			for (const entry of result.entries) entries.push(entry);
			for (const op of result.updates) applyUpdateToArray(entries, op);
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

	function handleEvent(msg: Record<string, unknown>) {
		// pending_clarifications: pass-through (still ephemeral/in-memory)
		if (msg.type === "pending_clarifications") {
			setPendingClarifications(
				msg.clarifications as {
					id: string;
					taskId: string;
					question: string;
					title?: string;
					body?: string;
					timestamp: number;
				}[],
			);
			return;
		}

		// Live event: process through the unified path
		const result = processEvent(msg);
		if (result.entries.length > 0) {
			setLogs((prev) => [...prev, ...result.entries]);
		}
		for (const op of result.updates) applyUpdateLive(op);
		result.sideEffects();
	}

	return { handleEvent, processEventBatch };
}
