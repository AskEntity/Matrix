import type React from "react";
import { createLogEntry, type LogEntry, type TaskNode } from "./hooks.ts";

// --- Update operations for in-place entry mutations ---

type UpdateOp =
	| { type: "merge_text"; taskId: string | undefined; text: string }
	| { type: "replace_text"; taskId: string | undefined; text: string }
	| {
			type: "complete_compact";
			text: string;
			checkpoint: string;
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
			{ id: string; taskId: string | null; text: string; timestamp: number }[]
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
		t,
	} = deps;

	/**
	 * Convert a raw queue message into a typed LogEntry with structured meta.
	 * Returns null for messages that should be skipped (child_complete, system).
	 */
	function createQueueEntry(
		rm: {
			source: string;
			content: string;
			images?: { base64: string; mediaType: string }[];
		},
		taskId?: string,
	): LogEntry | null {
		if (rm.source === "child_complete" || rm.source === "system") return null;
		if (rm.source === "user") {
			return createLogEntry({
				type: "user_message",
				text: rm.content,
				taskId,
				images: rm.images,
			});
		}
		if (rm.source === "parent_update") {
			return createLogEntry({
				type: "parent_update",
				text: rm.content,
				taskId,
				meta: { source: "parent_update" },
			});
		}
		if (rm.source === "child_report") {
			const childMatch = /^From child "([^"]*)" \(([^)]*)\): ([\s\S]*)$/.exec(
				rm.content,
			);
			return createLogEntry({
				type: "child_report",
				text: childMatch ? (childMatch[3] ?? rm.content) : rm.content,
				taskId,
				meta: {
					source: "child_report",
					childTitle: childMatch?.[1] ?? undefined,
					childTaskId: childMatch?.[2] ?? undefined,
				},
			});
		}
		if (rm.source === "background_complete") {
			const bgMatch =
				/^Command "([^"]*)" \(([^)]*)\): exit=([^,]*), duration=(\d+)ms/.exec(
					rm.content,
				);
			return createLogEntry({
				type: "background_complete",
				text: rm.content,
				taskId,
				meta: {
					source: "background_complete",
					command: bgMatch?.[1] ?? undefined,
					commandId: bgMatch?.[2] ?? undefined,
					exitCode: bgMatch?.[3] ?? undefined,
					durationMs: bgMatch?.[4] ?? undefined,
				},
			});
		}
		if (rm.source === "cross_project") {
			const cpMatch = /^From project "([^"]*)" \(([^)]*)\): ([\s\S]*)$/.exec(
				rm.content,
			);
			return createLogEntry({
				type: "cross_project",
				text: cpMatch ? (cpMatch[3] ?? rm.content) : rm.content,
				taskId,
				meta: {
					source: "cross_project",
					projectName: cpMatch?.[1] ?? undefined,
					projectId: cpMatch?.[2] ?? undefined,
				},
			});
		}
		// Generic fallback
		return createLogEntry({
			type: "queue_message",
			text: rm.content,
			taskId,
			meta: { source: rm.source },
		});
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
	 * Both batch (event_history) and live paths use this.
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
							text: msg.tool as string,
							taskId: msg.taskId as string | undefined,
							toolName: msg.tool as string,
							toolUseId: (msg.toolUseId as string) || undefined,
							toolArgs: msg.input as Record<string, unknown>,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "tool_result": {
				const toolImages = msg.images as
					| Array<{ base64: string; mediaType: string }>
					| undefined;
				return {
					entries: [
						createLogEntry({
							type: "tool_result",
							text: (msg.content as string) || "",
							taskId: msg.taskId as string | undefined,
							toolName: msg.tool as string,
							toolUseId: (msg.toolUseId as string) || undefined,
							toolResult: (msg.content as string) || "",
							isError: (msg.isError as boolean) || false,
							images: toolImages,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
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
							type: "compact_marker",
							text: "Compressing context...",
							taskId: msg.taskId as string | undefined,
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
							taskId: msg.taskId as string | undefined,
						},
					],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "queue_message": {
				const entries: LogEntry[] = [];
				const rawMessages = msg.rawMessages as
					| Array<{
							source: string;
							content: string;
							images?: { base64: string; mediaType: string }[];
					  }>
					| undefined;
				if (rawMessages && rawMessages.length > 0) {
					for (const rm of rawMessages) {
						const entry = createQueueEntry(
							rm,
							msg.taskId as string | undefined,
						);
						if (entry) entries.push(entry);
					}
				} else {
					const raw = (msg.messages as string) || "";
					if (raw) {
						entries.push(
							createLogEntry({
								type: "queue_message",
								text: raw,
								taskId: msg.taskId as string | undefined,
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
							text: "↻ Session resumed",
							taskId: startRootId,
						}),
					);
				}
				if (msg.prompt) {
					entries.push(
						createLogEntry({
							type: "user_message",
							text: msg.prompt as string,
							taskId: startRootId,
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
				const instruction = msg.message
					? `\n${t("lifecycle.instructions")} ${msg.message}`
					: "";
				const startedText = `${t("lifecycle.taskStarted")} ${msg.title}${instruction}`;
				const startedParentId =
					nodeMapRef.current.get(msg.taskId as string)?.parentId ?? undefined;
				const entries = [
					createLogEntry({
						type: "task_started",
						text: startedText,
						taskId: msg.taskId as string,
					}),
				];
				if (startedParentId) {
					entries.push(
						createLogEntry({
							type: "task_started",
							text: startedText,
							taskId: startedParentId,
						}),
					);
				}
				return { entries, updates: [], sideEffects: NO_SIDE_EFFECTS };
			}

			case "task_completed": {
				const output = (msg.output as string) || "";
				const completedText = output
					? `${msg.success ? "✓ Passed" : "✗ Failed"}: ${msg.title}\n${output}`
					: `${msg.success ? "✓ Passed" : "✗ Failed"}: ${msg.title}`;
				const completedMeta = {
					title: msg.title as string,
					success: msg.success as boolean,
					output,
				};
				const completedParentId =
					nodeMapRef.current.get(msg.taskId as string)?.parentId ?? undefined;
				const entries = [
					createLogEntry({
						type: "task_completed",
						text: completedText,
						taskId: msg.taskId as string,
						meta: completedMeta,
					}),
				];
				if (completedParentId) {
					entries.push(
						createLogEntry({
							type: "task_completed",
							text: completedText,
							taskId: completedParentId,
							meta: completedMeta,
						}),
					);
				}
				return { entries, updates: [], sideEffects: NO_SIDE_EFFECTS };
			}

			case "error":
				return {
					entries: [
						createLogEntry({
							type: "error",
							text: msg.message as string,
							taskId: msg.taskId as string | undefined,
						}),
					],
					updates: [],
					sideEffects: NO_SIDE_EFFECTS,
				};

			case "tree_mutation": {
				const action = msg.action as string;
				const title = (msg.title as string) || "";
				const mutationText = title ? `${action}: ${title}` : action;
				return {
					entries: [
						createLogEntry({ type: "tree_mutation", text: mutationText }),
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
						entries[i] = { ...e, text: e.text + op.text };
						return;
					}
					if (e && e.taskId === op.taskId && e.type !== "assistant_text") break;
				}
				// No existing text entry — create new
				entries.push(
					createLogEntry({
						type: "assistant_text",
						text: op.text,
						taskId: op.taskId,
					}),
				);
				break;
			}
			case "replace_text": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
						entries[i] = { ...e, text: op.text };
						return;
					}
					if (e && e.taskId === op.taskId && e.type !== "assistant_text") break;
				}
				entries.push(
					createLogEntry({
						type: "assistant_text",
						text: op.text,
						taskId: op.taskId,
					}),
				);
				break;
			}
			case "complete_compact": {
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e && e.type === "compact_marker" && e.checkpoint === undefined) {
						entries[i] = {
							...e,
							text: op.text,
							checkpoint: op.checkpoint,
						};
						return;
					}
				}
				// No pending compact entry — create completed one
				entries.push(
					createLogEntry({
						type: "compact_marker",
						text: op.text,
						taskId: op.taskId,
						checkpoint: op.checkpoint,
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
							updated[i] = { ...e, text: e.text + op.text };
							return updated;
						}
						if (e && e.taskId === op.taskId && e.type !== "assistant_text")
							break;
					}
					return [
						...prev,
						createLogEntry({
							type: "assistant_text",
							text: op.text,
							taskId: op.taskId,
						}),
					];
				}
				case "replace_text": {
					for (let i = prev.length - 1; i >= 0; i--) {
						const e = prev[i];
						if (e && e.type === "assistant_text" && e.taskId === op.taskId) {
							const updated = [...prev];
							updated[i] = { ...e, text: op.text };
							return updated;
						}
						if (e && e.taskId === op.taskId && e.type !== "assistant_text")
							break;
					}
					return [
						...prev,
						createLogEntry({
							type: "assistant_text",
							text: op.text,
							taskId: op.taskId,
						}),
					];
				}
				case "complete_compact": {
					for (let i = prev.length - 1; i >= 0; i--) {
						const e = prev[i];
						if (
							e &&
							e.type === "compact_marker" &&
							e.checkpoint === undefined
						) {
							const updated = [...prev];
							updated[i] = {
								...e,
								text: op.text,
								checkpoint: op.checkpoint,
							};
							return updated;
						}
					}
					return [
						...prev,
						createLogEntry({
							type: "compact_marker",
							text: op.text,
							taskId: op.taskId,
							checkpoint: op.checkpoint,
						}),
					];
				}
			}
		});
	}

	// --- Main handler ---

	function handleWS(msg: Record<string, unknown>) {
		// event_history: batch mode — collect all entries at once
		if (msg.type === "event_history") {
			const entries: LogEntry[] = [];
			const deferredSideEffects: (() => void)[] = [];
			for (const evt of msg.events as Record<string, unknown>[]) {
				const result = processEvent(evt);
				for (const entry of result.entries) entries.push(entry);
				for (const op of result.updates) applyUpdateToArray(entries, op);
				if (result.sideEffects !== NO_SIDE_EFFECTS) {
					deferredSideEffects.push(result.sideEffects);
				}
			}
			setLogs(entries);
			for (const fn of deferredSideEffects) fn();
			return;
		}

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

	return handleWS;
}
