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

	/**
	 * Convert a raw queue message into a UIEvent.
	 * Maps structured rawMessage fields directly to concrete Event types.
	 * Returns null for messages that should be skipped (child_complete, system_notification).
	 */
	function createQueueUIEvent(
		rm: {
			source: string;
			content?: string;
			images?: { base64: string; mediaType: string }[];
			taskId?: string;
			title?: string;
			success?: boolean;
			output?: string;
			requestReply?: boolean;
			fromProjectId?: string;
			fromProjectName?: string;
			command?: string;
			commandId?: string;
			exitCode?: number | null;
			durationMs?: number;
		},
		parentTaskId?: string,
	): UIEvent | null {
		const ts = Date.now();
		// child_complete, system_notification, and user messages don't show as separate log entries.
		// User messages are displayed via the user_message → messages_consumed lifecycle,
		// not via queue_message events.
		if (
			rm.source === "child_complete" ||
			rm.source === "system" ||
			rm.source === "user"
		)
			return null;
		if (rm.source === "parent_update") {
			return {
				type: "parent_update",
				content: rm.content ?? "",
				taskId: parentTaskId,
				ts,
			} as UIEvent;
		}
		if (rm.source === "child_report") {
			return {
				type: "child_report",
				taskId: rm.taskId ?? "",
				title: rm.title ?? "",
				content: rm.content ?? "",
				...(rm.requestReply ? { requestReply: true } : {}),
				ts,
			} as UIEvent;
		}
		if (rm.source === "background_complete") {
			return {
				type: "background_complete",
				command: rm.command ?? "",
				commandId: rm.commandId ?? "",
				exitCode: rm.exitCode ?? null,
				durationMs: rm.durationMs ?? 0,
				taskId: parentTaskId,
				ts,
			} as UIEvent;
		}
		if (rm.source === "cross_project") {
			return {
				type: "cross_project",
				fromProjectId: rm.fromProjectId ?? "",
				fromProjectName: rm.fromProjectName ?? "",
				content: rm.content ?? "",
				taskId: parentTaskId,
				ts,
			} as UIEvent;
		}
		// Generic fallback
		return {
			type: "generic_queue_message",
			content: rm.content ?? "",
			source: rm.source,
			taskId: parentTaskId,
			ts,
		};
	}

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
							rm as Parameters<typeof createQueueUIEvent>[0],
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
				// user_message with an id = injected message awaiting consumption.
				// Show as pending, not in activity log — messages_consumed will move it.
				const umId = msg.id as string | undefined;
				if (umId) {
					const umContent = (msg.content as string) || "";
					const umImages = msg.images as
						| Array<{ base64: string; mediaType: string }>
						| undefined;
					const umTaskId = msg.taskId as string | null | undefined;
					return {
						entries: [],
						updates: [],
						sideEffects: () => {
							setPendingMessages((prev) => [
								...prev,
								{
									id: umId,
									taskId: umTaskId ?? null,
									text: umContent,
									timestamp: (msg.ts as number) ?? Date.now(),
									images: umImages,
								},
							]);
						},
					};
				}
				// user_message without id = initial prompt, show directly in activity log
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
							taskId: msg.taskId as string | undefined,
							ts: (msg.ts as number) ?? Date.now(),
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};
			}

			case "messages_consumed": {
				// Move consumed messages from pending to activity log
				const consumedIds = new Set((msg.messageIds as string[]) ?? []);
				if (consumedIds.size === 0) {
					return { entries: [], updates: [], sideEffects: NO_SIDE_EFFECTS };
				}
				return {
					entries: [],
					updates: [],
					sideEffects: () => {
						setPendingMessages((prev) => {
							const consumed = prev.filter((p) => consumedIds.has(p.id));
							const remaining = prev.filter((p) => !consumedIds.has(p.id));
							// Add consumed messages to activity log
							if (consumed.length > 0) {
								setLogs((prevLogs) => [
									...prevLogs,
									...consumed.map((p) =>
										createLogEntry({
											type: "user_message",
											content: p.text,
											...((p as Record<string, unknown>).images
												? {
														images: (p as Record<string, unknown>)
															.images as Array<{
															base64: string;
															mediaType: string;
														}>,
													}
												: {}),
											taskId: p.taskId ?? undefined,
											ts: (msg.ts as number) ?? Date.now(),
										}),
									),
								]);
							}
							return remaining;
						});
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

		// Track user_message events with IDs for two-phase resolution
		const pendingUserMsgs = new Map<
			string,
			{
				content: string;
				images?: Array<{ base64: string; mediaType: string }>;
				taskId?: string;
				ts: number;
			}
		>();
		// Track which IDs have been consumed (by messages_consumed events)
		const consumedIds = new Set<string>();

		for (const evt of events) {
			const evtType = evt.type as string;

			// Two-phase user message: collect with-id user_messages for later resolution
			if (evtType === "user_message" && evt.id) {
				pendingUserMsgs.set(evt.id as string, {
					content: (evt.content as string) || "",
					images: evt.images as
						| Array<{ base64: string; mediaType: string }>
						| undefined,
					taskId: evt.taskId as string | undefined,
					ts: (evt.ts as number) ?? Date.now(),
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
						entries.push(
							createLogEntry({
								type: "user_message",
								content: userMsg.content,
								...(userMsg.images ? { images: userMsg.images } : {}),
								taskId: userMsg.taskId,
								ts,
							}),
						);
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
						entries.push(
							createLogEntry({
								type: "user_message",
								content: userMsg.content,
								...(userMsg.images ? { images: userMsg.images } : {}),
								taskId: userMsg.taskId,
								ts,
							}),
						);
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

		// Any unconsumed user messages with IDs go to pending
		const unconsumed = [...pendingUserMsgs.entries()]
			.filter(([id]) => !consumedIds.has(id))
			.map(([id, m]) => ({
				id,
				taskId: m.taskId ?? null,
				text: m.content,
				timestamp: m.ts,
				images: m.images,
			}));
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
