import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityLog } from "./components/ActivityLog.tsx";
import { AppFooter } from "./components/AppFooter.tsx";
import { AppHeader } from "./components/AppHeader.tsx";
import { CuteCat } from "./components/CuteCat.tsx";
import {
	IconArrowDown,
	IconClose,
	IconHexagon,
	IconPlus,
	IconRefresh,
} from "./components/icons.tsx";
import { OrchestratorDetail } from "./components/OrchestratorDetail.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { TaskDetail } from "./components/TaskDetail.tsx";
import { TaskTree } from "./components/TaskTree.tsx";
import {
	formatTokenCount,
	TokenUsageBadge,
} from "./components/TokenUsageBadge.tsx";

import {
	createLogEntry,
	type LogEntry,
	type TaskNode,
	useAgent,
	useProjects,
	useTasks,
	useThreeLayerConfig,
	useWebSocket,
} from "./hooks.ts";

type StructuredFields = {
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	toolResult?: string;
	isError?: boolean;
};

import { LocaleProvider, useLocale } from "./i18n.ts";
import { applyTheme, themes } from "./themes.ts";

// ── Hash routing helpers ───────────────────────────────────────────────────

function parseHash(): { projectId?: string; taskId?: string } {
	const raw = window.location.hash.replace(/^#/, "");
	if (!raw) return {};
	const slash = raw.indexOf("/");
	if (slash === -1) return { projectId: raw };
	return { projectId: raw.slice(0, slash), taskId: raw.slice(slash + 1) };
}

function updateHash(
	projectId: string,
	taskId: string | null,
	rootNodeId: string | null,
) {
	const hash =
		taskId && taskId !== rootNodeId
			? `#${projectId}/${taskId}`
			: projectId
				? `#${projectId}`
				: "";
	if (window.location.hash !== hash) {
		window.location.hash = hash;
	}
}

// ── Main App ───────────────────────────────────────────────────────────────

export function App() {
	return (
		<LocaleProvider>
			<AppInner />
		</LocaleProvider>
	);
}

function AppInner() {
	const { t } = useLocale();
	const {
		projects,
		refresh: refreshProjects,
		initProject,
		deleteProject,
	} = useProjects();
	const initialHash = useMemo(() => parseHash(), []);
	const [projectId, setProjectId] = useState(initialHash.projectId ?? "");
	const [showAddProject, setShowAddProject] = useState(false);
	const [newProjectPath, setNewProjectPath] = useState("");
	const [creatingProject, setCreatingProject] = useState(false);
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
		initialHash.taskId ?? null,
	);
	const [rootNodeId, setRootNodeId] = useState<string | null>(null);
	const [targetNodeId, setTargetNodeId] = useState<string | null>(null);
	const [lastCostUsd, setLastCostUsd] = useState<number | null>(null);
	const [lastTurns, setLastTurns] = useState<number | null>(null);
	const [lastInputTokens, setLastInputTokens] = useState<number | null>(null);
	const [lastCacheCreationTokens, setLastCacheCreationTokens] = useState<
		number | null
	>(null);
	const [lastCacheReadTokens, setLastCacheReadTokens] = useState<number | null>(
		null,
	);
	const [lastOutputTokens, setLastOutputTokens] = useState<number | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [prompt, setPrompt] = useState(
		() => localStorage.getItem("og-prompt-draft") ?? "",
	);
	const [showSettings, setShowSettings] = useState(false);
	const [splitRatio, setSplitRatio] = useState(0.35);
	const [isDragging, setIsDragging] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	const [theme, setThemeState] = useState<
		"dark" | "light" | "cute-light" | "cute-dark"
	>(() => {
		const stored = localStorage.getItem("og-theme");
		if (stored === "light" || stored === "cute-light" || stored === "cute-dark")
			return stored;
		return "dark";
	});
	const [tokenUsage, setTokenUsage] = useState<
		Record<
			string,
			{ inputTokens: number; contextWindow: number; estimated?: boolean }
		>
	>({});
	const [pendingMessages, setPendingMessages] = useState<
		{ id: string; taskId: string | null; text: string; timestamp: number }[]
	>([]);
	const [pendingClarifications, setPendingClarifications] = useState<
		{ id: string; taskId: string; question: string; timestamp: number }[]
	>([]);
	const [clarifyAnswers, setClarifyAnswers] = useState<Record<string, string>>(
		{},
	);
	const [attachedImages, setAttachedImages] = useState<
		{ base64: string; mediaType: string }[]
	>([]);
	const lastSubmittedImagesRef = useRef<
		{ base64: string; mediaType: string }[] | undefined
	>(undefined);
	const [compacting, setCompacting] = useState(false);
	const contentPanelRef = useRef<HTMLElement>(null);

	const { nodes, refresh: refreshTasks, updateFromWS } = useTasks(projectId);
	const {
		running,
		setRunning,
		provider: agentProvider,
		setProvider: setAgentProvider,
		model: agentModel,
		setModel: setAgentModel,
		start,
		stop,
		checkStatus,
		compact,
		continueTask,
		deleteTask,
		sendMessage,
		sendMessageToTask,
	} = useAgent(projectId);
	const {
		layers,
		loading: configLoading,
		updateGlobal,
		updateRepo,
		updateLocal,
	} = useThreeLayerConfig(projectId);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TaskNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);
	const nodeMapRef = useRef(nodeMap);
	nodeMapRef.current = nodeMap;

	const totalCost = useMemo(() => {
		const sum = nodes.reduce((acc, n) => acc + (n.costUsd ?? 0), 0);
		return sum > 0 ? sum : null;
	}, [nodes]);

	const isOrchestratorNode = !selectedTaskId || selectedTaskId === rootNodeId;
	const selectedNode =
		selectedTaskId && !isOrchestratorNode
			? (nodeMap.get(selectedTaskId) ?? null)
			: null;

	const isSelectedTaskRunning =
		running && selectedNode?.status === "in_progress";

	const addLog = useCallback(
		(
			type: string,
			text: string,
			taskId?: string,
			checkpoint?: string,
			structured?: StructuredFields,
			images?: { base64: string; mediaType: string }[],
		) => {
			const entry = createLogEntry(type, text, taskId, structured, images);
			if (checkpoint) entry.checkpoint = checkpoint;
			setLogs((prev) => [...prev, entry]);
		},
		[],
	);

	// ── Effects ──────────────────────────────────────────────────────────────

	useEffect(() => {
		const config = themes[theme];
		if (config) applyTheme(config);
		localStorage.setItem("og-theme", theme);
	}, [theme]);

	useEffect(() => {
		const childNodes = rootNodeId
			? nodes.filter((n) => n.id !== rootNodeId)
			: nodes;
		const total = childNodes.length;
		if (total === 0) {
			document.title = "OpenGraft";
			return;
		}
		const passed = childNodes.filter((n) => n.status === "passed").length;
		const failed = childNodes.filter(
			(n) => n.status === "failed" || n.status === "stuck",
		).length;
		if (failed > 0) document.title = `[!${failed}] OpenGraft`;
		else if (passed === total) document.title = "[✓] OpenGraft";
		else document.title = `[${passed}/${total}] OpenGraft`;
	}, [nodes, rootNodeId]);

	const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setIsDragging(true);
	}, []);

	useEffect(() => {
		if (!isDragging) return;
		const handleMouseMove = (e: MouseEvent) => {
			const panel = contentPanelRef.current;
			if (!panel) return;
			const rect = panel.getBoundingClientRect();
			const ratio = Math.min(
				0.85,
				Math.max(0.1, (e.clientY - rect.top) / rect.height),
			);
			setSplitRatio(ratio);
		};
		const handleMouseUp = () => setIsDragging(false);
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable;
			if (e.key === "Escape" && !isInput) {
				setSelectedTaskId(rootNodeId);
				setTargetNodeId(null);
			}
			if (e.key === "/" && !isInput) {
				e.preventDefault();
				(
					document.querySelector(".og-log-search") as HTMLInputElement | null
				)?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [rootNodeId]);

	// ── WebSocket handler ────────────────────────────────────────────────────

	const handleWS = useCallback(
		(msg: Record<string, unknown>) => {
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
					} else if (et === "text") {
						text = (msg.content as string) || "";
					} else if (et === "error") {
						text = (msg.message as string) || "";
					} else if (et === "usage") {
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
						break;
					} else if (et === "compact_started") {
						setCompacting(true);
						break;
					} else if (et === "compact") {
						text = `Context compacted (saved ~${msg.savedTokens} tokens)`;
						addLog(
							et,
							text,
							msg.taskId as string | undefined,
							msg.checkpoint as string,
						);
						setCompacting(false);
						break;
					} else if (et === "queue_message") {
						const taskId = msg.taskId as string | undefined;
						const rawMessages = msg.rawMessages as
							| Array<{ source: string; content: string }>
							| undefined;
						if (rawMessages && rawMessages.length > 0) {
							// Structured path — no text parsing needed
							for (const rm of rawMessages) {
								if (rm.source === "child_complete") continue;
								if (rm.source === "user") {
									addLog("user_prompt", rm.content, taskId);
									continue;
								}
								if (rm.source === "parent_update") {
									addLog(
										"queue_message",
										`← From Parent: ${rm.content}`,
										taskId,
									);
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
									addLog(
										"queue_message",
										`[${rm.source}] ${rm.content}`,
										taskId,
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
					setCompacting(false);
					break;
				}
				case "agent_stopped":
					addLog(
						"lifecycle",
						"Agent stopped",
						msg.taskId as string | undefined,
					);
					setRunning(false);
					setCompacting(false);
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
					setPendingMessages((msg.messages as typeof pendingMessages) ?? []);
					break;
				case "pending_clarifications":
					setPendingClarifications(
						(msg.clarifications as typeof pendingClarifications) ?? [],
					);
					break;
			}
		},
		[addLog, updateFromWS, setRunning, setAgentProvider, setAgentModel, t],
	);

	const { connected } = useWebSocket(projectId, handleWS);

	useEffect(() => {
		if (projects.length === 0) return;
		if (projectId && projects.some((p) => p.id === projectId)) return;
		const first = projects[0];
		if (first) setProjectId(first.id);
	}, [projects, projectId]);

	// ── Hash routing sync ────────────────────────────────────────────────────

	// Update hash when projectId or selectedTaskId changes
	useEffect(() => {
		if (projectId) updateHash(projectId, selectedTaskId, rootNodeId);
	}, [projectId, selectedTaskId, rootNodeId]);

	// Listen for browser back/forward (hashchange)
	useEffect(() => {
		const onHashChange = () => {
			const { projectId: hp, taskId: ht } = parseHash();
			if (hp && hp !== projectId) {
				setProjectId(hp);
				setSelectedTaskId(ht ?? rootNodeId);
				setLogs([]);
			} else if (ht && ht !== selectedTaskId) {
				setSelectedTaskId(ht);
			} else if (!ht && selectedTaskId !== rootNodeId) {
				setSelectedTaskId(rootNodeId);
			}
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, [projectId, selectedTaskId, rootNodeId]);

	useEffect(() => {
		if (projectId) checkStatus();
	}, [projectId, checkStatus]);

	useEffect(() => {
		if (!projectId) {
			setPendingMessages([]);
			return;
		}
		fetch(`/projects/${projectId}/pending-messages`)
			.then((r) => r.json())
			.then((data: { messages: typeof pendingMessages }) =>
				setPendingMessages(data.messages ?? []),
			)
			.catch(() => setPendingMessages([]));
	}, [projectId]);

	useEffect(() => {
		if (!projectId) {
			setPendingClarifications([]);
			setClarifyAnswers({});
			return;
		}
		fetch(`/projects/${projectId}/clarifications`)
			.then((r) => r.json())
			.then((data: { clarifications: typeof pendingClarifications }) =>
				setPendingClarifications(data.clarifications ?? []),
			)
			.catch(() => setPendingClarifications([]));
	}, [projectId]);

	useEffect(() => {
		if (!selectedTaskId || selectedTaskId === rootNodeId) {
			setTargetNodeId(null);
			return;
		}
		const node = nodeMap.get(selectedTaskId);
		setTargetNodeId(node?.status === "in_progress" ? selectedTaskId : null);
	}, [selectedTaskId, nodeMap, rootNodeId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only trigger on task selection change
	useEffect(() => {
		setAutoScroll(true);
		requestAnimationFrame(() => {
			const logEl = document.querySelector(".og-activity-log");
			if (logEl) logEl.scrollTop = logEl.scrollHeight;
		});
	}, [selectedTaskId]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (prompt) localStorage.setItem("og-prompt-draft", prompt);
			else localStorage.removeItem("og-prompt-draft");
		}, 2000);
		return () => clearTimeout(timer);
	}, [prompt]);

	useEffect(() => {
		const handler = () => {
			if (prompt) localStorage.setItem("og-prompt-draft", prompt);
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [prompt]);

	// ── Handlers ─────────────────────────────────────────────────────────────

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!prompt.trim() || !projectId) return;
		const images = attachedImages.length > 0 ? attachedImages : undefined;
		try {
			if (running) {
				if (targetNodeId) await sendMessageToTask(targetNodeId, prompt.trim());
				else await sendMessage(prompt.trim(), images);
			} else {
				lastSubmittedImagesRef.current = images;
				await start({ prompt: prompt.trim() });
			}
			setPrompt("");
			setAttachedImages([]);
			localStorage.removeItem("og-prompt-draft");
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleStop() {
		try {
			await stop();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleClarifySubmit(clarificationId: string) {
		if (!projectId) return;
		const answer = clarifyAnswers[clarificationId]?.trim();
		if (!answer) return;
		const clarification = pendingClarifications.find(
			(c) => c.id === clarificationId,
		);
		if (!clarification) return;
		try {
			const res = await fetch(`/projects/${projectId}/clarify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					taskId: clarification.taskId,
					clarificationId: clarification.id,
					answer,
				}),
			});
			if (!res.ok) {
				const body = (await res.json()) as { error: string };
				addLog("error", `Failed to answer clarification: ${body.error}`);
				return;
			}
			setClarifyAnswers((prev) => {
				const next = { ...prev };
				delete next[clarificationId];
				return next;
			});
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleClearSessions() {
		if (!confirm(t("confirm.clearSessions"))) return;
		try {
			const res = await fetch(`/projects/${projectId}/sessions/clear`, {
				method: "POST",
			});
			if (!res.ok) throw new Error((await res.json()).error);
			setLastCostUsd(null);
			setLastTurns(null);
			setLastInputTokens(null);
			setLastCacheCreationTokens(null);
			setLastCacheReadTokens(null);
			setLastOutputTokens(null);
			setLogs([]);
			addLog("lifecycle", "Session history cleared");
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleContinueTask(msg?: string) {
		if (!selectedTaskId) return;
		try {
			await continueTask(selectedTaskId, msg);
			addLog(
				"task_started",
				`↳ Continued: ${selectedNode?.title}`,
				selectedTaskId,
			);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleDeleteTask() {
		if (!selectedTaskId || !selectedNode) return;
		if (!confirm(t("confirm.deleteTask", { title: selectedNode.title })))
			return;
		try {
			await deleteTask(selectedTaskId);
			addLog("lifecycle", `Deleted: ${selectedNode.title}`);
			setSelectedTaskId(rootNodeId);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handlePauseTask() {
		if (!selectedTaskId) return;
		try {
			await sendMessageToTask(
				selectedTaskId,
				"⏸ PAUSED by user. Please call yield() and wait for further instructions before continuing.",
			);
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleAddProject(e: React.FormEvent) {
		e.preventDefault();
		const path = newProjectPath.trim();
		if (!path || creatingProject) return;
		setCreatingProject(true);
		try {
			const project = await initProject(path);
			setProjectId(project.id);
			setSelectedTaskId(null);
			setRootNodeId(null);
			setLogs([]);
			setNewProjectPath("");
			setShowAddProject(false);
		} catch (err) {
			addLog("error", (err as Error).message);
		} finally {
			setCreatingProject(false);
		}
	}

	async function handleDeleteProject() {
		if (!projectId) return;
		const project = projects.find((p) => p.id === projectId);
		if (
			!confirm(t("confirm.removeProject", { name: project?.name ?? projectId }))
		)
			return;
		try {
			await deleteProject(projectId);
			setProjectId("");
			setSelectedTaskId(null);
			setRootNodeId(null);
			setLogs([]);
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleAddTask() {
		if (!projectId) return;
		const title = window.prompt(t("prompt.taskTitle"));
		if (!title) return;
		const description = window.prompt(t("prompt.taskDescription")) ?? "";
		const body: Record<string, string> = { title, description };
		if (selectedTaskId && !isOrchestratorNode) body.parentId = selectedTaskId;
		try {
			const res = await fetch(`/projects/${projectId}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok)
				throw new Error(((await res.json()) as { error: string }).error);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	const filterLabel = isOrchestratorNode
		? t("orch.label")
		: selectedNode
			? selectedNode.title
			: null;

	// ── Render ───────────────────────────────────────────────────────────────

	return (
		<>
			<AppHeader
				connected={connected}
				projects={projects}
				projectId={projectId}
				showAddProject={showAddProject}
				newProjectPath={newProjectPath}
				creatingProject={creatingProject}
				showSettings={showSettings}
				theme={theme}
				onProjectChange={(id) => {
					setProjectId(id);
					setSelectedTaskId(null);
					setRootNodeId(null);
					setLogs([]);
				}}
				onDeleteProject={handleDeleteProject}
				onShowAddProject={() => setShowAddProject(true)}
				onAddProject={handleAddProject}
				onNewProjectPathChange={setNewProjectPath}
				onCancelAddProject={() => {
					setShowAddProject(false);
					setNewProjectPath("");
				}}
				onToggleSettings={() => setShowSettings((s) => !s)}
				onThemeChange={(t) => setThemeState(t as typeof theme)}
			/>

			{showSettings && projectId && (
				<SettingsPanel
					projectId={projectId}
					layers={layers}
					loading={configLoading}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
					onClose={() => setShowSettings(false)}
					onRestart={async () => {
						try {
							await fetch("/restart-daemon", { method: "POST" });
							addLog("lifecycle", "Daemon restarting…");
						} catch {
							addLog("lifecycle", "Daemon restarting…");
						}
					}}
				/>
			)}

			<main className="og-main">
				<aside className="og-sidebar">
					<div className="og-panel-header">
						<span className="og-panel-title">{t("tasks.title")}</span>
						<div className="og-panel-actions">
							{selectedTaskId && !isOrchestratorNode && (
								<>
									<span className="og-filter-chip" title={filterLabel ?? ""}>
										{filterLabel}
									</span>
									<button
										type="button"
										className="og-btn-icon"
										onClick={() => setSelectedTaskId(rootNodeId)}
										data-tip={t("tasks.clearFilter")}
									>
										<IconClose size={11} />
									</button>
								</>
							)}
							<button
								type="button"
								className="og-btn-icon"
								onClick={handleAddTask}
								data-tip={t("tasks.addTask")}
							>
								<IconPlus size={13} />
							</button>
							<button
								type="button"
								className="og-btn-icon"
								onClick={() => {
									refreshTasks();
									refreshProjects();
								}}
								data-tip={t("tasks.refresh")}
							>
								<IconRefresh size={13} />
							</button>
						</div>
					</div>
					<TaskTree
						nodes={nodes}
						selectedTaskId={selectedTaskId}
						rootNodeId={rootNodeId}
						onSelect={setSelectedTaskId}
						running={running}
					/>
				</aside>

				<section
					className={`og-content${isDragging ? " dragging" : ""}`}
					ref={contentPanelRef}
				>
					<div
						className="og-detail-panel"
						style={{ flex: splitRatio, minHeight: 0 }}
					>
						<div className="og-panel-header">
							<span className="og-panel-title">
								{isOrchestratorNode
									? t("orch.label")
									: selectedNode
										? t("detail.title")
										: t("detail.details")}
							</span>
						</div>
						{isOrchestratorNode ? (
							<OrchestratorDetail
								running={running}
								nodes={nodes}
								rootNodeId={rootNodeId}
								costUsd={lastCostUsd}
								totalCost={totalCost}
								turns={lastTurns}
								inputTokens={lastInputTokens}
								cacheCreationTokens={lastCacheCreationTokens}
								cacheReadTokens={lastCacheReadTokens}
								outputTokens={lastOutputTokens}
								provider={agentProvider}
								model={agentModel}
								onClearSessions={handleClearSessions}
								onStop={handleStop}
							/>
						) : selectedNode ? (
							<TaskDetail
								node={selectedNode}
								projectId={projectId}
								onContinue={handleContinueTask}
								onDelete={handleDeleteTask}
								onPause={handlePauseTask}
							/>
						) : (
							<div className="og-detail-empty">
								<IconHexagon size={28} />
								<span>{t("detail.selectTask")}</span>
							</div>
						)}
					</div>

					{/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle */}
					<div
						className="og-resize-divider"
						onMouseDown={handleDividerMouseDown}
					/>

					<div className="og-activity-panel" style={{ flex: 1 - splitRatio }}>
						<div className="og-panel-header">
							<span className="og-panel-title">
								{t("activity.title")}
								{filterLabel && !isOrchestratorNode && (
									<span
										style={{
											color: "var(--text-faint)",
											marginLeft: "6px",
											fontSize: "10px",
											fontWeight: 400,
											textTransform: "none",
											letterSpacing: 0,
										}}
									>
										— {filterLabel}
									</span>
								)}
							</span>
							<div className="og-panel-actions">
								{(() => {
									const usageTaskId =
										targetNodeId ??
										selectedTaskId ??
										rootNodeId ??
										nodes.find((n) => !n.parentId && n.status === "in_progress")
											?.id ??
										"orchestrator";
									const usage = tokenUsage[usageTaskId];
									return usage ? (
										<TokenUsageBadge
											inputTokens={usage.inputTokens}
											contextWindow={usage.contextWindow}
											estimated={usage.estimated}
											onCompact={running ? () => compact() : undefined}
										/>
									) : null;
								})()}
								{!autoScroll && (
									<button
										type="button"
										className="og-scroll-follow-btn"
										onClick={() => setAutoScroll(true)}
									>
										<IconArrowDown size={10} />
										{t("activity.follow")}
									</button>
								)}
							</div>
						</div>
						<ActivityLog
							entries={logs}
							filterTaskId={selectedTaskId}
							rootNodeId={rootNodeId}
							nodeMap={nodeMap}
							autoScroll={autoScroll}
							onAutoScrollChange={setAutoScroll}
							running={isSelectedTaskRunning}
							compacting={compacting}
						/>
					</div>
				</section>
			</main>

			<AppFooter
				running={running}
				projectId={projectId}
				prompt={prompt}
				targetNodeId={targetNodeId}
				nodeMap={nodeMap}
				pendingMessages={pendingMessages}
				pendingClarifications={pendingClarifications}
				clarifyAnswers={clarifyAnswers}
				attachedImages={attachedImages}
				onPromptChange={setPrompt}
				onSubmit={handleSubmit}
				onImageAttach={(img) => setAttachedImages((prev) => [...prev, img])}
				onImageRemove={(index) =>
					setAttachedImages((prev) => prev.filter((_, i) => i !== index))
				}
				onClarifySubmit={handleClarifySubmit}
				onClarifyAnswerChange={(clarificationId, value) =>
					setClarifyAnswers((prev) => ({
						...prev,
						[clarificationId]: value,
					}))
				}
			/>

			{themes[theme]?.hasCat && <CuteCat />}
		</>
	);
}
