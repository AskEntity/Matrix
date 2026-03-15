import type React from "react";
import { formatTokenCount } from "./components/TokenUsageBadge.tsx";
import { createLogEntry, type LogEntry, type TaskNode } from "./hooks.ts";

type StructuredFields = {
	toolName?: string;
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
) => void;

export interface WSHandlerDeps {
	addLog: AddLogFn;
	updateFromWS: (nodes: TaskNode[]) => void;
	setRootNodeId: React.Dispatch<React.SetStateAction<string | null>>;
	setRunning: (running: boolean) => void;
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
		setRunning,
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
						toolArgs: msg.input as Record<string, unknown>,
					});
					break;
				} else if (et === "tool_result") {
					text = (msg.content as string) || "";
					addLog(et, text, msg.taskId as string | undefined, undefined, {
						toolName: msg.tool as string,
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
					text = (msg.content as string) || "";
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
							if (rm.source === "child_complete") continue;
							if (rm.source === "user") {
								addLog("user_prompt", rm.content, taskId);
								continue;
							}
							if (rm.source === "parent_update") {
								addLog("queue_message", `← From Parent: ${rm.content}`, taskId);
							} else if (rm.source === "child_report") {
								addLog(
									"queue_message",
									`↑ Child Report: ${rm.content}`,
									taskId,
								);
							} else if (rm.source === "background_complete") {
								addLog(
									"queue_message",
									`⚙ Background Complete: ${rm.content}`,
									taskId,
								);
							} else {
								addLog("queue_message", `[${rm.source}] ${rm.content}`, taskId);
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
				const startRootId = msg.taskId as string | undefined;
				if (startRootId) setRootNodeId(startRootId);
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
				addLog("lifecycle", "Orchestration started", startRootId);
				setRunning(true);
				if (msg.provider) setAgentProvider(msg.provider as string);
				if (msg.model) setAgentModel(msg.model as string);
				break;
			}
			case "orchestration_completed": {
				const costStr = msg.costUsd
					? ` · ${(msg.costUsd as number).toFixed(3)}`
					: "";
				const hasTokens =
					msg.inputTokens !== undefined ||
					msg.cacheCreationTokens !== undefined ||
					msg.cacheReadTokens !== undefined ||
					msg.outputTokens !== undefined;
				const tokenStr = hasTokens
					? ` · ${formatTokenCount((msg.inputTokens as number) ?? 0)} in · ${formatTokenCount((msg.cacheCreationTokens as number) ?? 0)} write · ${formatTokenCount((msg.cacheReadTokens as number) ?? 0)} read · ${formatTokenCount((msg.outputTokens as number) ?? 0)} out`
					: "";
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
				addLog(
					"lifecycle",
					`Orchestration ${msg.success ? "completed ✓" : "failed ✗"}${costStr}${tokenStr}`,
					msg.taskId as string | undefined,
				);
				setRunning(false);
				setPendingCompact(false);
				break;
			}
			case "agent_stopped":
				addLog("lifecycle", "Agent stopped", msg.taskId as string | undefined);
				setRunning(false);
				setPendingCompact(false);
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
				const completedText = `${msg.success ? "✓ Passed" : "✗ Failed"}: ${msg.title}`;
				const completedParentId =
					nodeMapRef.current.get(msg.taskId as string)?.parentId ?? undefined;
				addLog("task_completed", completedText, msg.taskId as string);
				if (completedParentId)
					addLog("task_completed", completedText, completedParentId);
				break;
			}
			case "error":
				addLog(
					"error",
					msg.message as string,
					msg.taskId as string | undefined,
				);
				break;
			case "event_history": {
				setLogs([]);
				for (const evt of msg.events as Record<string, unknown>[])
					handleWS(evt);
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
