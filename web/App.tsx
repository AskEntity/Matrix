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
import { formatArgs } from "./components/ToolCard.tsx";
import {
	createLogEntry,
	type LogEntry,
	type TaskNode,
	useAgent,
	useProjectConfig,
	useProjects,
	useTasks,
	useWebSocket,
} from "./hooks.ts";
import { LocaleProvider, useLocale } from "./i18n.ts";
import { applyTheme, themes } from "./themes.ts";
import { PROJECT_NODE_ID } from "./types.ts";

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
	const [projectId, setProjectId] = useState("");
	const [showAddProject, setShowAddProject] = useState(false);
	const [newProjectPath, setNewProjectPath] = useState("");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
		PROJECT_NODE_ID,
	);
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
		continueTask,
		deleteTask,
		sendMessage,
		sendMessageToTask,
	} = useAgent(projectId);
	const { config: projectConfig, updateConfig } = useProjectConfig(projectId);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TaskNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	const totalCost = useMemo(() => {
		const sum = nodes.reduce((acc, n) => acc + (n.costUsd ?? 0), 0);
		return sum > 0 ? sum : null;
	}, [nodes]);

	const isOrchestratorNode = selectedTaskId === PROJECT_NODE_ID;
	const selectedNode =
		selectedTaskId && !isOrchestratorNode
			? (nodeMap.get(selectedTaskId) ?? null)
			: null;

	const addLog = useCallback(
		(type: string, text: string, taskId?: string, checkpoint?: string) => {
			const entry = createLogEntry(type, text, taskId);
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
		const total = nodes.length;
		if (total === 0) {
			document.title = "OpenGraft";
			return;
		}
		const passed = nodes.filter((n) => n.status === "passed").length;
		const failed = nodes.filter(
			(n) => n.status === "failed" || n.status === "stuck",
		).length;
		if (failed > 0) document.title = `[!${failed}] OpenGraft`;
		else if (passed === total) document.title = "[✓] OpenGraft";
		else document.title = `[${passed}/${total}] OpenGraft`;
	}, [nodes]);

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
				setSelectedTaskId(PROJECT_NODE_ID);
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
	}, []);

	// ── WebSocket handler ────────────────────────────────────────────────────

	const handleWS = useCallback(
		(msg: Record<string, unknown>) => {
			switch (msg.type) {
				case "tree_updated":
					updateFromWS(msg.nodes as TaskNode[]);
					break;
				case "agent_event": {
					const et = msg.eventType as string;
					let text = "";
					if (et === "tool_use") {
						text = `${msg.tool}(${formatArgs(msg.input as Record<string, unknown>)})`;
					} else if (et === "tool_result") {
						text = `${msg.isError ? "ERR" : "OK"} ${msg.tool}: ${(msg.content as string) || ""}`;
					} else if (et === "text") {
						text = (msg.content as string) || "";
					} else if (et === "error") {
						text = (msg.message as string) || "";
					} else if (et === "usage") {
						const usageKey =
							(msg.taskId as string | undefined) || PROJECT_NODE_ID;
						setTokenUsage((prev) => ({
							...prev,
							[usageKey]: {
								inputTokens: msg.inputTokens as number,
								contextWindow: msg.contextWindow as number,
								estimated: (msg.estimated as boolean) || false,
							},
						}));
						break;
					} else if (et === "compact") {
						text = `Context compacted (saved ~${msg.savedTokens} tokens)`;
						addLog(
							et,
							text,
							msg.taskId as string | undefined,
							msg.checkpoint as string,
						);
						break;
					} else if (et === "queue_message") {
						const raw = (msg.messages as string) || "";
						const taskId = msg.taskId as string | undefined;
						const lines = raw
							.split(/\n(?=\[)/)
							.filter((l) => l.trim() && !l.startsWith("## "));
						let parsed = false;
						for (const line of lines) {
							const m = /^\[([^\]]+)\] (.*)$/s.exec(line);
							if (m) {
								parsed = true;
								const msgType = m[1];
								const msgText = m[2] ?? "";
								if (msgType === "child_complete") continue;
								if (msgType === "user") {
									addLog("user_prompt", msgText, taskId);
								} else if (msgType === "parent_update") {
									addLog("queue_message", `← From Parent: ${msgText}`, taskId);
								} else if (msgType === "child_report") {
									addLog("queue_message", `↑ Child Report: ${msgText}`, taskId);
								} else {
									addLog("queue_message", `[${msgType}] ${msgText}`, taskId);
								}
							}
						}
						if (!parsed) addLog("queue_message", raw, taskId);
						break;
					} else if (et === "status") {
						// Internal status events — not shown in activity log (implementation noise)
						break;
					} else {
						text = JSON.stringify(msg).slice(0, 2000);
					}
					addLog(et, text, msg.taskId as string | undefined);
					break;
				}
				case "orchestration_started":
					if (msg.prompt) addLog("user_prompt", msg.prompt as string);
					addLog("lifecycle", "Orchestration started");
					setRunning(true);
					if (msg.provider) setAgentProvider(msg.provider as string);
					if (msg.model) setAgentModel(msg.model as string);
					break;
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
					);
					setRunning(false);
					break;
				}
				case "agent_stopped":
					addLog("lifecycle", "Agent stopped");
					setRunning(false);
					break;
				case "task_started": {
					const instruction = msg.message
						? `\n${t("lifecycle.instructions")} ${msg.message}`
						: "";
					addLog(
						"task_started",
						`${t("lifecycle.taskStarted")} ${msg.title}${instruction}`,
						msg.taskId as string,
					);
					break;
				}
				case "task_completed":
					addLog(
						"task_completed",
						`${msg.success ? "✓ Passed" : "✗ Failed"}: ${msg.title}`,
						msg.taskId as string,
					);
					break;
				case "error":
					addLog("error", msg.message as string);
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
		if (projects.length > 0 && !projectId && projects[0])
			setProjectId(projects[0].id);
	}, [projects, projectId]);

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
		if (!selectedTaskId || selectedTaskId === PROJECT_NODE_ID) {
			setTargetNodeId(null);
			return;
		}
		const node = nodeMap.get(selectedTaskId);
		setTargetNodeId(node?.status === "in_progress" ? selectedTaskId : null);
	}, [selectedTaskId, nodeMap]);

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
		try {
			if (running) {
				if (targetNodeId) await sendMessageToTask(targetNodeId, prompt.trim());
				else await sendMessage(prompt.trim());
			} else {
				await start({ prompt: prompt.trim() });
			}
			setPrompt("");
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
			setSelectedTaskId(PROJECT_NODE_ID);
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
		if (!path) return;
		try {
			const project = await initProject(path);
			setProjectId(project.id);
			setNewProjectPath("");
			setShowAddProject(false);
		} catch (err) {
			addLog("error", (err as Error).message);
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
			setSelectedTaskId(PROJECT_NODE_ID);
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
				showSettings={showSettings}
				theme={theme}
				onProjectChange={(id) => {
					setProjectId(id);
					setSelectedTaskId(PROJECT_NODE_ID);
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
					config={projectConfig}
					updateConfig={updateConfig}
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
							{selectedTaskId && selectedTaskId !== PROJECT_NODE_ID && (
								<>
									<span className="og-filter-chip" title={filterLabel ?? ""}>
										{filterLabel}
									</span>
									<button
										type="button"
										className="og-btn-icon"
										onClick={() => setSelectedTaskId(PROJECT_NODE_ID)}
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
								nodeCount={nodes.length}
								nodes={nodes}
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
								{filterLabel && selectedTaskId !== PROJECT_NODE_ID && (
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
										(selectedTaskId === PROJECT_NODE_ID
											? PROJECT_NODE_ID
											: (selectedTaskId ?? null)) ??
										nodes.find((n) => !n.parentId && n.status === "in_progress")
											?.id ??
										PROJECT_NODE_ID;
									const usage = tokenUsage[usageTaskId];
									return usage ? (
										<TokenUsageBadge
											inputTokens={usage.inputTokens}
											contextWindow={usage.contextWindow}
											estimated={usage.estimated}
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
							nodeMap={nodeMap}
							autoScroll={autoScroll}
							onAutoScrollChange={setAutoScroll}
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
				onPromptChange={setPrompt}
				onSubmit={handleSubmit}
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
