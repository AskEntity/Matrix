import type React from "react";
import { createLogEntry, type LogEntry, type TaskNode } from "./hooks.ts";

type StructuredFields = {
	toolName?: string;
	toolUseId?: string;
	toolArgs?: Record<string, unknown>;
	toolResult?: string;
	isError?: boolean;
};

type AddLogFn = (
	type: string,
	text: string,
	taskId?: string,
	checkpoint?: string,
	structured?: StructuredFields,
	images?: { base64: string; mediaType: string }[],
	meta?: Record<string, unknown>,
) => void;

export interface WSHandlerDeps {
	addLog: AddLogFn;
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
	setPendingCompact: React.Dispatch<React.SetStateAction<boolean>>;
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
	setLastCostUsd: React.Dispatch<React.SetStateAction<number | null>>;
	setLastTurns: React.Dispatch<React.SetStateAction<number | null>>;
	setLastInputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastCacheCreationTokens: React.Dispatch<
		React.SetStateAction<number | null>
	>;
	setLastCacheReadTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastOutputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	lastSubmittedImagesRef: React.MutableRefObject<
		{ base64: string; mediaType: string }[] | undefined
	>;
	nodeMapRef: React.MutableRefObject<Map<string, TaskNode>>;
	t: (key: string, params?: Record<string, string>) => string;
}

export function createWSHandler(deps: WSHandlerDeps) {
	const {
		addLog,
		updateFromWS,
		setRootNodeId,
		setActiveAgents,
		checkAgentStatus,
		setAgentProvider,
		setAgentModel,
		setLogs,
		setTokenUsage,
		setPendingCompact,
		setPendingMessages,
		setPendingClarifications,
		setLastCostUsd,
		setLastTurns,
		setLastInputTokens,
		setLastCacheCreationTokens,
		setLastCacheReadTokens,
		setLastOutputTokens,
		lastSubmittedImagesRef,
		nodeMapRef,
		t,
	} = deps;

	/**
	 * Convert a raw queue message into a typed LogEntry with structured meta.
	 * Returns null for messages that should be skipped (child_complete, system).
	 */
	function createQueueEntry(
		rm: { source: string; content: string },
		taskId?: string,
	): LogEntry | null {
		if (rm.source === "child_complete" || rm.source === "system") return null;
		if (rm.source === "user") {
			return createLogEntry("user_prompt", rm.content, taskId);
		}
		if (rm.source === "parent_update") {
			return createLogEntry(
				"parent_update",
				rm.content,
				taskId,
				undefined,
				undefined,
				{ source: "parent_update" },
			);
		}
		if (rm.source === "child_report") {
			// Content format: From child "title" (taskId): message
			const childMatch = /^From child "([^"]*)" \(([^)]*)\): ([\s\S]*)$/.exec(
				rm.content,
			);
			return createLogEntry(
				"child_report",
				childMatch ? (childMatch[3] ?? rm.content) : rm.content,
				taskId,
				undefined,
				undefined,
				{
					source: "child_report",
					childTitle: childMatch?.[1] ?? undefined,
					childTaskId: childMatch?.[2] ?? undefined,
				},
			);
		}
		if (rm.source === "background_complete") {
			// Content format: Command "cmd" (id): exit=N, duration=Nms. ...
			const bgMatch =
				/^Command "([^"]*)" \(([^)]*)\): exit=([^,]*), duration=(\d+)ms/.exec(
					rm.content,
				);
			return createLogEntry(
				"background_complete",
				rm.content,
				taskId,
				undefined,
				undefined,
				{
					source: "background_complete",
					command: bgMatch?.[1] ?? undefined,
					commandId: bgMatch?.[2] ?? undefined,
					exitCode: bgMatch?.[3] ?? undefined,
					durationMs: bgMatch?.[4] ?? undefined,
				},
			);
		}
		if (rm.source === "cross_project") {
			// Content format: From project "name" (id): message
			const cpMatch = /^From project "([^"]*)" \(([^)]*)\): ([\s\S]*)$/.exec(
				rm.content,
			);
			return createLogEntry(
				"cross_project",
				cpMatch ? (cpMatch[3] ?? rm.content) : rm.content,
				taskId,
				undefined,
				undefined,
				{
					source: "cross_project",
					projectName: cpMatch?.[1] ?? undefined,
					projectId: cpMatch?.[2] ?? undefined,
				},
			);
		}
		// Generic fallback — still use queue_message type
		return createLogEntry(
			"queue_message",
			rm.content,
			taskId,
			undefined,
			undefined,
			{ source: rm.source },
		);
	}

	/**
	 * Pure entry-building function: converts an event into LogEntry items
	 * and appends them to the `entries` array. Handles text_delta merging
	 * and compact updates in-place on the accumulator.
	 *
	 * Returns true if the event was fully handled (no side effects needed),
	 * false if the caller should also process side effects.
	 */
	function collectEntries(
		msg: Record<string, unknown>,
		entries: LogEntry[],
	): boolean {
		switch (msg.type) {
			case "tree_updated":
				// No log entries — only side effects
				return false;
			case "agent_event": {
				const et = msg.eventType as string;
				if (et === "tool_use") {
					entries.push(
						createLogEntry(
							et,
							msg.tool as string,
							msg.taskId as string | undefined,
							{
								toolName: msg.tool as string,
								toolUseId: (msg.toolUseId as string) || undefined,
								toolArgs: msg.input as Record<string, unknown>,
							},
						),
					);
					return true;
				}
				if (et === "tool_result") {
					entries.push(
						createLogEntry(
							et,
							(msg.content as string) || "",
							msg.taskId as string | undefined,
							{
								toolName: msg.tool as string,
								toolUseId: (msg.toolUseId as string) || undefined,
								toolResult: (msg.content as string) || "",
								isError: (msg.isError as boolean) || false,
							},
						),
					);
					return true;
				}
				if (et === "text_delta") {
					const deltaText = (msg.content as string) || "";
					const deltaTaskId = msg.taskId as string | undefined;
					if (deltaText) {
						// Merge into last text entry for same taskId, or create new
						let merged = false;
						for (let i = entries.length - 1; i >= 0; i--) {
							const e = entries[i];
							if (e && e.type === "text" && e.taskId === deltaTaskId) {
								entries[i] = { ...e, text: e.text + deltaText };
								merged = true;
								break;
							}
							if (e && e.taskId === deltaTaskId && e.type !== "text") break;
						}
						if (!merged) {
							entries.push(createLogEntry("text", deltaText, deltaTaskId));
						}
					}
					return true;
				}
				if (et === "text") {
					entries.push(
						createLogEntry(
							et,
							(msg.content as string) || "",
							msg.taskId as string | undefined,
						),
					);
					return true;
				}
				if (et === "error") {
					entries.push(
						createLogEntry(
							et,
							(msg.message as string) || "",
							msg.taskId as string | undefined,
						),
					);
					return true;
				}
				if (et === "usage") {
					// No log entries — only side effects
					return false;
				}
				if (et === "compact_started") {
					const entry = createLogEntry(
						"compact",
						"Compressing context...",
						msg.taskId as string | undefined,
					);
					entry.checkpoint = "";
					entries.push(entry);
					return false; // also has setPendingCompact side effect
				}
				if (et === "compact") {
					const compactText = `Context compacted (saved ~${msg.savedTokens} tokens)`;
					const compactCheckpoint = msg.checkpoint as string;
					const compactTaskId = msg.taskId as string | undefined;
					// Update existing compact_started entry in-place
					let updated = false;
					for (let i = entries.length - 1; i >= 0; i--) {
						const e = entries[i];
						if (e && e.type === "compact" && !e.checkpoint) {
							entries[i] = {
								...e,
								text: compactText,
								checkpoint: compactCheckpoint,
							};
							updated = true;
							break;
						}
					}
					if (!updated) {
						const entry = createLogEntry("compact", compactText, compactTaskId);
						entry.checkpoint = compactCheckpoint;
						entries.push(entry);
					}
					return true;
				}
				if (et === "queue_message") {
					const taskId = msg.taskId as string | undefined;
					const rawMessages = msg.rawMessages as
						| Array<{ source: string; content: string }>
						| undefined;
					if (rawMessages && rawMessages.length > 0) {
						for (const rm of rawMessages) {
							const entry = createQueueEntry(rm, taskId);
							if (entry) entries.push(entry);
						}
					} else {
						const raw = (msg.messages as string) || "";
						if (raw) entries.push(createLogEntry("queue_message", raw, taskId));
					}
					return true;
				}
				if (et === "status") {
					const statusText = (msg.message as string) || "";
					if (statusText.includes("Compress")) {
						entries.push(
							createLogEntry(
								"status",
								statusText,
								msg.taskId as string | undefined,
							),
						);
					}
					return true;
				}
				// Unknown event type
				entries.push(
					createLogEntry(
						et,
						JSON.stringify(msg).slice(0, 2000),
						msg.taskId as string | undefined,
					),
				);
				return true;
			}
			case "orchestration_started": {
				// No log entry for normal starts — sessions are persistent, lifecycle cards are noise.
				// Still push the user prompt if present, and show a subtle indicator on resume.
				const startRootId = msg.taskId as string | undefined;
				if (msg.resume) {
					entries.push(
						createLogEntry("lifecycle", "↻ Session resumed", startRootId),
					);
				}
				if (msg.prompt) {
					entries.push(
						createLogEntry("user_prompt", msg.prompt as string, startRootId),
					);
				}
				return false; // side effects only (setRunning, setAgentProvider, etc.)
			}
			case "orchestration_completed":
				// No log entry — side effects only (cost/token stats).
				return false;
			case "agent_stopped":
				// No log entry — side effects only (activeAgents, setPendingCompact).
				return false;
			case "agent_active":
			case "agent_idle":
				// No log entry — side effects only (activeAgents set).
				return false;
			case "task_started": {
				const instruction = msg.message
					? `\n${t("lifecycle.instructions")} ${msg.message}`
					: "";
				const startedText = `${t("lifecycle.taskStarted")} ${msg.title}${instruction}`;
				const startedParentId =
					nodeMapRef.current.get(msg.taskId as string)?.parentId ?? undefined;
				entries.push(
					createLogEntry("task_started", startedText, msg.taskId as string),
				);
				if (startedParentId)
					entries.push(
						createLogEntry("task_started", startedText, startedParentId),
					);
				return true;
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
				// Add to both child and parent logs
				entries.push(
					createLogEntry(
						"task_completed",
						completedText,
						msg.taskId as string,
						undefined,
						undefined,
						completedMeta,
					),
				);
				if (completedParentId)
					entries.push(
						createLogEntry(
							"task_completed",
							completedText,
							completedParentId,
							undefined,
							undefined,
							completedMeta,
						),
					);
				return true;
			}
			case "error":
				entries.push(
					createLogEntry(
						"error",
						msg.message as string,
						msg.taskId as string | undefined,
					),
				);
				return true;
			case "tree_mutation": {
				const action = msg.action as string;
				const title = (msg.title as string) || "";
				const mutationText = title ? `${action}: ${title}` : action;
				entries.push(createLogEntry("tree_mutation", mutationText));
				return true;
			}
			default:
				return true;
		}
	}

	/**
	 * Process side effects only (state setters other than setLogs/addLog).
	 * Called during event_history replay after entries are batched.
	 */
	function processSideEffects(msg: Record<string, unknown>) {
		switch (msg.type) {
			case "tree_updated":
				updateFromWS(msg.nodes as TaskNode[]);
				if (msg.rootNodeId) setRootNodeId(msg.rootNodeId as string);
				break;
			case "agent_event": {
				const et = msg.eventType as string;
				if (et === "usage") {
					const usageKey = (msg.taskId as string | undefined) ?? "orchestrator";
					setTokenUsage((prev) => ({
						...prev,
						[usageKey]: {
							inputTokens: msg.inputTokens as number,
							contextWindow: msg.contextWindow as number,
							estimated: (msg.estimated as boolean) || false,
						},
					}));
				} else if (et === "compact_started") {
					setPendingCompact(false);
				}
				break;
			}
			case "orchestration_started": {
				const startRootId = msg.taskId as string | undefined;
				if (startRootId) {
					setRootNodeId(startRootId);
					setActiveAgents((prev) => new Set(prev).add(startRootId));
				}
				if (msg.provider) setAgentProvider(msg.provider as string);
				if (msg.model) setAgentModel(msg.model as string);
				break;
			}
			case "orchestration_completed":
				if (msg.costUsd !== undefined) setLastCostUsd(msg.costUsd as number);
				if (msg.turns !== undefined) setLastTurns(msg.turns as number);
				if (msg.inputTokens !== undefined)
					setLastInputTokens(msg.inputTokens as number);
				if (msg.cacheCreationTokens !== undefined)
					setLastCacheCreationTokens(msg.cacheCreationTokens as number);
				if (msg.cacheReadTokens !== undefined)
					setLastCacheReadTokens(msg.cacheReadTokens as number);
				if (msg.outputTokens !== undefined)
					setLastOutputTokens(msg.outputTokens as number);
				// Remove this agent from active set, then re-check (auto-resume may restart)
				if (msg.taskId) {
					setActiveAgents((prev) => {
						const next = new Set(prev);
						next.delete(msg.taskId as string);
						return next;
					});
				}
				checkAgentStatus();
				setPendingCompact(false);
				break;
			case "agent_stopped":
				// Remove this agent from active set, then re-check (auto-resume may restart)
				if (msg.taskId) {
					setActiveAgents((prev) => {
						const next = new Set(prev);
						next.delete(msg.taskId as string);
						return next;
					});
				}
				checkAgentStatus();
				setPendingCompact(false);
				break;
			case "agent_active":
				if (msg.taskId) {
					setActiveAgents((prev) => new Set(prev).add(msg.taskId as string));
				}
				break;
			case "agent_idle":
				if (msg.taskId) {
					setActiveAgents((prev) => {
						const next = new Set(prev);
						next.delete(msg.taskId as string);
						return next;
					});
				}
				break;
		}
	}

	function handleWS(msg: Record<string, unknown>) {
		switch (msg.type) {
			case "tree_updated":
				updateFromWS(msg.nodes as TaskNode[]);
				if (msg.rootNodeId) {
					setRootNodeId(msg.rootNodeId as string);
				}
				break;
			case "agent_event": {
				const et = msg.eventType as string;
				let text = "";
				if (et === "tool_use") {
					text = msg.tool as string;
					addLog(et, text, msg.taskId as string | undefined, undefined, {
						toolName: msg.tool as string,
						toolUseId: (msg.toolUseId as string) || undefined,
						toolArgs: msg.input as Record<string, unknown>,
					});
					break;
				} else if (et === "tool_result") {
					text = (msg.content as string) || "";
					addLog(et, text, msg.taskId as string | undefined, undefined, {
						toolName: msg.tool as string,
						toolUseId: (msg.toolUseId as string) || undefined,
						toolResult: (msg.content as string) || "",
						isError: (msg.isError as boolean) || false,
					});
					break;
				} else if (et === "text_delta") {
					const deltaText = (msg.content as string) || "";
					const deltaTaskId = msg.taskId as string | undefined;
					if (deltaText) {
						setLogs((prev) => {
							for (let i = prev.length - 1; i >= 0; i--) {
								const e = prev[i];
								if (e && e.type === "text" && e.taskId === deltaTaskId) {
									const updated = [...prev];
									updated[i] = { ...e, text: e.text + deltaText };
									return updated;
								}
								if (e && e.taskId === deltaTaskId && e.type !== "text") break;
							}
							return [...prev, createLogEntry("text", deltaText, deltaTaskId)];
						});
					}
					break;
				} else if (et === "text") {
					// Consolidated text event — replace the text_delta-accumulated entry
					// if one exists (avoids duplicates during live streaming)
					const fullText = (msg.content as string) || "";
					const textTaskId = msg.taskId as string | undefined;
					if (fullText) {
						setLogs((prev) => {
							for (let i = prev.length - 1; i >= 0; i--) {
								const e = prev[i];
								if (e && e.type === "text" && e.taskId === textTaskId) {
									const updated = [...prev];
									updated[i] = { ...e, text: fullText };
									return updated;
								}
								if (e && e.taskId === textTaskId && e.type !== "text") break;
							}
							return [...prev, createLogEntry("text", fullText, textTaskId)];
						});
					}
					break;
				} else if (et === "error") {
					text = (msg.message as string) || "";
				} else if (et === "usage") {
					const usageKey = (msg.taskId as string | undefined) ?? "orchestrator";
					setTokenUsage((prev) => ({
						...prev,
						[usageKey]: {
							inputTokens: msg.inputTokens as number,
							contextWindow: msg.contextWindow as number,
							estimated: (msg.estimated as boolean) || false,
						},
					}));
					break;
				} else if (et === "compact_started") {
					setPendingCompact(false);
					setLogs((prev) => {
						for (let i = prev.length - 1; i >= 0; i--) {
							const e = prev[i];
							if (e && e.type === "compact" && !e.checkpoint) {
								return prev;
							}
						}
						const entry = createLogEntry(
							"compact",
							"Compressing context...",
							msg.taskId as string | undefined,
						);
						entry.checkpoint = "";
						return [...prev, entry];
					});
					break;
				} else if (et === "compact") {
					const compactText = `Context compacted (saved ~${msg.savedTokens} tokens)`;
					const compactCheckpoint = msg.checkpoint as string;
					const compactTaskId = msg.taskId as string | undefined;
					setLogs((prev) => {
						for (let i = prev.length - 1; i >= 0; i--) {
							const e = prev[i];
							if (e && e.type === "compact" && !e.checkpoint) {
								const updated = [...prev];
								updated[i] = {
									...e,
									text: compactText,
									checkpoint: compactCheckpoint,
								};
								return updated;
							}
						}
						const entry = createLogEntry("compact", compactText, compactTaskId);
						entry.checkpoint = compactCheckpoint;
						return [...prev, entry];
					});
					break;
				} else if (et === "queue_message") {
					const taskId = msg.taskId as string | undefined;
					const rawMessages = msg.rawMessages as
						| Array<{ source: string; content: string }>
						| undefined;
					if (rawMessages && rawMessages.length > 0) {
						for (const rm of rawMessages) {
							const entry = createQueueEntry(rm, taskId);
							if (entry) {
								// Attach pending images to user_prompt entries
								let imgs: { base64: string; mediaType: string }[] | undefined;
								if (
									entry.type === "user_prompt" &&
									lastSubmittedImagesRef.current
								) {
									imgs = lastSubmittedImagesRef.current;
									lastSubmittedImagesRef.current = undefined;
								}
								addLog(
									entry.type,
									entry.text,
									entry.taskId,
									undefined,
									undefined,
									imgs,
									entry.meta,
								);
							}
						}
					} else {
						const raw = (msg.messages as string) || "";
						if (raw) addLog("queue_message", raw, taskId);
					}
					break;
				} else if (et === "status") {
					const statusText = (msg.message as string) || "";
					if (statusText.includes("Compress")) {
						addLog("status", statusText, msg.taskId as string | undefined);
					}
					break;
				} else {
					text = JSON.stringify(msg).slice(0, 2000);
				}
				addLog(et, text, msg.taskId as string | undefined);
				break;
			}
			case "orchestration_started": {
				// No log entry for normal starts — sessions are persistent, lifecycle cards are noise.
				// Show a subtle indicator on resume, and the user prompt if present.
				const startRootId = msg.taskId as string | undefined;
				if (startRootId) {
					setRootNodeId(startRootId);
					setActiveAgents((prev) => new Set(prev).add(startRootId));
				}
				if (msg.resume) {
					addLog("lifecycle", "↻ Session resumed", startRootId);
				}
				if (msg.prompt) {
					const imgs = lastSubmittedImagesRef.current;
					lastSubmittedImagesRef.current = undefined;
					addLog(
						"user_prompt",
						msg.prompt as string,
						startRootId,
						undefined,
						undefined,
						imgs,
					);
				}
				if (msg.provider) setAgentProvider(msg.provider as string);
				if (msg.model) setAgentModel(msg.model as string);
				break;
			}
			case "orchestration_completed": {
				// No log entry — side effects only (cost/token stats).
				if (msg.costUsd !== undefined) setLastCostUsd(msg.costUsd as number);
				if (msg.turns !== undefined) setLastTurns(msg.turns as number);
				if (msg.inputTokens !== undefined)
					setLastInputTokens(msg.inputTokens as number);
				if (msg.cacheCreationTokens !== undefined)
					setLastCacheCreationTokens(msg.cacheCreationTokens as number);
				if (msg.cacheReadTokens !== undefined)
					setLastCacheReadTokens(msg.cacheReadTokens as number);
				if (msg.outputTokens !== undefined)
					setLastOutputTokens(msg.outputTokens as number);
				// Remove agent from active set, then re-check (auto-resume may restart)
				if (msg.taskId) {
					setActiveAgents((prev) => {
						const next = new Set(prev);
						next.delete(msg.taskId as string);
						return next;
					});
				}
				checkAgentStatus();
				setPendingCompact(false);
				break;
			}
			case "agent_stopped":
				// No log entry — side effects only.
				// Remove agent from active set, then re-check (auto-resume may restart)
				if (msg.taskId) {
					setActiveAgents((prev) => {
						const next = new Set(prev);
						next.delete(msg.taskId as string);
						return next;
					});
				}
				checkAgentStatus();
				setPendingCompact(false);
				break;
			case "agent_active":
				if (msg.taskId) {
					setActiveAgents((prev) => new Set(prev).add(msg.taskId as string));
				}
				break;
			case "agent_idle":
				if (msg.taskId) {
					setActiveAgents((prev) => {
						const next = new Set(prev);
						next.delete(msg.taskId as string);
						return next;
					});
				}
				break;
			case "task_started": {
				const instruction = msg.message
					? `\n${t("lifecycle.instructions")} ${msg.message}`
					: "";
				const startedText = `${t("lifecycle.taskStarted")} ${msg.title}${instruction}`;
				const startedParentId =
					nodeMapRef.current.get(msg.taskId as string)?.parentId ?? undefined;
				addLog("task_started", startedText, msg.taskId as string);
				if (startedParentId)
					addLog("task_started", startedText, startedParentId);
				break;
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
				// Add to both child and parent logs
				addLog(
					"task_completed",
					completedText,
					msg.taskId as string,
					undefined,
					undefined,
					undefined,
					completedMeta,
				);
				if (completedParentId)
					addLog(
						"task_completed",
						completedText,
						completedParentId,
						undefined,
						undefined,
						undefined,
						completedMeta,
					);
				break;
			}
			case "error":
				addLog(
					"error",
					msg.message as string,
					msg.taskId as string | undefined,
				);
				break;
			case "tree_mutation": {
				const action = msg.action as string;
				const title = (msg.title as string) || "";
				const mutationText = title ? `${action}: ${title}` : action;
				addLog("tree_mutation", mutationText);
				break;
			}
			case "event_history": {
				// Batch all entries at once to avoid intermediate renders where
				// tool_result entries exist without their matching tool_use,
				// which causes raw JSON to flash before tool cards render.
				const entries: LogEntry[] = [];
				for (const evt of msg.events as Record<string, unknown>[]) {
					collectEntries(evt, entries);
					processSideEffects(evt);
				}
				setLogs(entries);
				break;
			}
			case "pending_messages":
				setPendingMessages(
					(msg.messages as {
						id: string;
						taskId: string | null;
						text: string;
						timestamp: number;
					}[]) ?? [],
				);
				break;
			case "pending_clarifications":
				setPendingClarifications(
					(msg.clarifications as {
						id: string;
						taskId: string;
						question: string;
						timestamp: number;
					}[]) ?? [],
				);
				break;
		}
	}

	return handleWS;
}
