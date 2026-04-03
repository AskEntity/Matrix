import type React from "react";
import { api } from "./api.ts";
import { authFetch } from "./auth.ts";
import type { LogEntry, Project, TaskNode, UIEvent } from "./hooks.ts";

type AddLogFn = (event: UIEvent) => void;

interface ActionHandlerDeps {
	projectId: string;
	selectedTaskId: string | null;
	rootNodeId: string | null;
	selectedNode: TaskNode | null;
	isOrchestratorNode: boolean;
	targetNodeId: string | null;
	clarifyAnswers: Record<string, string>;
	pendingClarifications: {
		id: string;
		taskId: string;
		question: string;
		timestamp: number;
	}[];
	newProjectPath: string;
	creatingProject: boolean;
	projects: Project[];

	addLog: AddLogFn;
	setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
	setLastTurns: React.Dispatch<React.SetStateAction<number | null>>;
	setLastInputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastCacheCreationTokens: React.Dispatch<
		React.SetStateAction<number | null>
	>;
	setLastCacheReadTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastOutputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setProjectId: React.Dispatch<React.SetStateAction<string>>;
	setSelectedTaskId: React.Dispatch<React.SetStateAction<string | null>>;
	setRootNodeId: React.Dispatch<React.SetStateAction<string | null>>;
	setClarifyAnswers: React.Dispatch<
		React.SetStateAction<Record<string, string>>
	>;
	setPendingClarifications: React.Dispatch<
		React.SetStateAction<
			{
				id: string;
				taskId: string;
				question: string;
				title?: string;
				body?: string;
				timestamp: number;
			}[]
		>
	>;
	setCreatingProject: React.Dispatch<React.SetStateAction<boolean>>;
	setNewProjectPath: React.Dispatch<React.SetStateAction<string>>;
	setShowAddProject: React.Dispatch<React.SetStateAction<boolean>>;
	setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
	setIsCreatingTask: React.Dispatch<React.SetStateAction<boolean>>;
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
	setActiveAgents: React.Dispatch<React.SetStateAction<Set<string>>>;
	setOlderEventsAvailable: React.Dispatch<
		React.SetStateAction<Map<string, { hasOlder: boolean; oldestTs: number }>>
	>;

	start: (opts: { prompt: string }) => Promise<void>;
	stop: () => Promise<void>;
	compact: (nodeId?: string) => Promise<void>;
	sendMessageToTask: (
		taskId: string,
		msg: string,
		images?: { base64: string; mediaType: string }[],
	) => Promise<void>;
	deleteTask: (taskId: string) => Promise<void>;
	stopTask: (taskId: string) => Promise<void>;
	clearTaskSession: (taskId: string) => Promise<void>;
	initProject: (path: string) => Promise<{ id: string }>;
	deleteProject: (id: string) => Promise<void>;
	refreshTasks: () => void;
	t: (key: string, params?: Record<string, string>) => string;
}

export function createActionHandlers(deps: ActionHandlerDeps) {
	const {
		projectId,
		selectedTaskId,
		rootNodeId,
		selectedNode,
		isOrchestratorNode,
		targetNodeId,
		clarifyAnswers,
		pendingClarifications,
		newProjectPath,
		creatingProject,
		projects,
		addLog,
		setLogs,
		setLastTurns,
		setLastInputTokens,
		setLastCacheCreationTokens,
		setLastCacheReadTokens,
		setLastOutputTokens,
		setProjectId,
		setSelectedTaskId,
		setRootNodeId,
		setClarifyAnswers,
		setPendingClarifications,
		setCreatingProject,
		setNewProjectPath,
		setShowAddProject,
		setShowSettings,
		setIsCreatingTask,
		setTokenUsage,
		setPendingMessages,
		setBackgroundProcesses,
		setActiveAgents,
		setOlderEventsAvailable,
		start,
		stop,
		compact,
		sendMessageToTask,
		deleteTask,
		stopTask,
		clearTaskSession,
		initProject,
		deleteProject,
		refreshTasks,
		t,
	} = deps;

	/** Handle slash commands like /compact and /clear. Returns true if handled. */
	async function handleSlashCommand(command: string): Promise<boolean> {
		const cmd = command.trim().toLowerCase();
		if (cmd === "/compact") {
			try {
				const nodeId =
					targetNodeId ?? selectedTaskId ?? rootNodeId ?? undefined;
				await compact(nodeId);
			} catch (err) {
				addLog({
					type: "error",
					message: (err as Error).message,
					taskId: "",
					ts: Date.now(),
				});
			}
			return true;
		}
		if (cmd === "/stop") {
			try {
				await stop();
			} catch (err) {
				addLog({
					type: "error",
					message: (err as Error).message,
					taskId: "",
					ts: Date.now(),
				});
			}
			return true;
		}
		if (cmd === "/clear") {
			if (!confirm(t("confirm.clearSessions"))) return true;
			try {
				const res = await authFetch(api.sessionsClear(projectId), {
					method: "POST",
				});
				if (!res.ok) throw new Error((await res.json()).error);
				setLastTurns(null);
				setLastInputTokens(null);
				setLastCacheCreationTokens(null);
				setLastCacheReadTokens(null);
				setLastOutputTokens(null);
				setLogs([]);
			} catch (err) {
				addLog({
					type: "error",
					message: (err as Error).message,
					taskId: "",
					ts: Date.now(),
				});
			}
			return true;
		}
		if (cmd === "/settings") {
			setShowSettings(true);
			return true;
		}
		if (cmd === "/dump-messages") {
			try {
				const nodeId =
					targetNodeId ?? selectedTaskId ?? rootNodeId ?? undefined;
				const res = await authFetch(api.debugDumpMessages(projectId), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(nodeId ? { nodeId } : {}),
				});
				if (!res.ok) throw new Error((await res.json()).error);
				const data = await res.json();
				// Trigger file download
				const blob = new Blob([JSON.stringify(data, null, 2)], {
					type: "application/json",
				});
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = `messages-dump-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
				a.click();
				URL.revokeObjectURL(url);
				// Success: file download is the indicator, no log needed.
			} catch (err) {
				addLog({
					type: "error",
					message: (err as Error).message,
					taskId: "",
					ts: Date.now(),
				});
			}
			return true;
		}
		return false;
	}

	async function handleSend(
		message: string,
		images?: { base64: string; mediaType: string }[],
	) {
		if (!message.trim() || !projectId) return;

		// Check for slash commands before sending as a chat message
		if (message.trim().startsWith("/")) {
			const handled = await handleSlashCommand(message.trim());
			if (handled) return;
		}

		try {
			// Determine target: explicit child target, or root node
			const nodeId = targetNodeId ?? rootNodeId;
			if (nodeId) {
				// Unified path: all messages go through the task message endpoint.
				// For root nodes, the endpoint delegates to handleInjectMessage
				// which handles auto-launch, cold-start headers, and resume.
				await sendMessageToTask(nodeId, message.trim(), images);
			} else {
				// No root node yet — need to start the orchestrator first
				await start({ prompt: message.trim() });
			}
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	async function handleStop() {
		try {
			await stop();
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
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
			const res = await authFetch(api.clarify(projectId), {
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
				addLog({
					type: "error",
					message: `Failed to answer clarification: ${body.error}`,
					taskId: "",
					ts: Date.now(),
				});
				return;
			}
			// Optimistically remove the answered clarification from the banner
			// immediately, rather than waiting for the SSE broadcast which may
			// be delayed or lost during brief disconnects.
			setPendingClarifications((prev) =>
				prev.filter((c) => c.id !== clarificationId),
			);
			setClarifyAnswers((prev) => {
				const next = { ...prev };
				delete next[clarificationId];
				return next;
			});
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	async function handleClearSessions() {
		if (!confirm(t("confirm.clearSessions"))) return;
		try {
			const res = await authFetch(api.sessionsClear(projectId), {
				method: "POST",
			});
			if (!res.ok) throw new Error((await res.json()).error);
			setLastTurns(null);
			setLastInputTokens(null);
			setLastCacheCreationTokens(null);
			setLastCacheReadTokens(null);
			setLastOutputTokens(null);
			setLogs([]);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	async function handleDeleteTask() {
		if (!selectedTaskId || !selectedNode) return;
		if (!confirm(t("confirm.deleteTask", { title: selectedNode.title })))
			return;
		try {
			await deleteTask(selectedTaskId);
			setSelectedTaskId(rootNodeId);
			await refreshTasks();
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	async function handleStopTask() {
		if (!selectedTaskId) return;
		try {
			await stopTask(selectedTaskId);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	async function handleClearTaskSession() {
		if (!selectedTaskId || !selectedNode) return;
		if (!confirm(t("confirm.clearTaskSession", { title: selectedNode.title })))
			return;
		try {
			await clearTaskSession(selectedTaskId);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	async function handleClearRootSession() {
		if (!rootNodeId) return;
		if (!confirm(t("confirm.clearRootSession"))) return;
		try {
			await clearTaskSession(rootNodeId);
			setLastTurns(null);
			setLastInputTokens(null);
			setLastCacheCreationTokens(null);
			setLastCacheReadTokens(null);
			setLastOutputTokens(null);
			setLogs([]);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
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
			setTokenUsage({});
			setPendingMessages([]);
			setPendingClarifications([]);
			setBackgroundProcesses(new Map());
			setActiveAgents(new Set());
			setOlderEventsAvailable(new Map());
			setLastTurns(null);
			setLastInputTokens(null);
			setLastCacheCreationTokens(null);
			setLastCacheReadTokens(null);
			setLastOutputTokens(null);
			setNewProjectPath("");
			setShowAddProject(false);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
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
			setTokenUsage({});
			setPendingMessages([]);
			setPendingClarifications([]);
			setBackgroundProcesses(new Map());
			setActiveAgents(new Set());
			setOlderEventsAvailable(new Map());
			setLastTurns(null);
			setLastInputTokens(null);
			setLastCacheCreationTokens(null);
			setLastCacheReadTokens(null);
			setLastOutputTokens(null);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	function handleAddTask() {
		if (!projectId) return;
		setIsCreatingTask(true);
	}

	async function handleCreateTask(title: string) {
		if (!projectId) return;
		setIsCreatingTask(false);
		const body: Record<string, string> = { title };
		if (selectedTaskId && !isOrchestratorNode) body.parentId = selectedTaskId;
		try {
			const res = await authFetch(api.tasks(projectId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok)
				throw new Error(((await res.json()) as { error: string }).error);
			const newNode = (await res.json()) as { id: string };
			setSelectedTaskId(newNode.id);
			await refreshTasks();
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	function handleCancelCreate() {
		setIsCreatingTask(false);
	}

	async function handleDeleteTaskByDrag(taskId: string) {
		if (!projectId) return;
		try {
			await deleteTask(taskId);
			if (selectedTaskId === taskId) setSelectedTaskId(rootNodeId);
			await refreshTasks();
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				taskId: "",
				ts: Date.now(),
			});
		}
	}

	return {
		handleSend,
		handleStop,
		handleClarifySubmit,
		handleClearSessions,
		handleClearRootSession,
		handleDeleteTask,
		handleStopTask,
		handleClearTaskSession,
		handleAddProject,
		handleDeleteProject,
		handleAddTask,
		handleCreateTask,
		handleCancelCreate,
		handleDeleteTaskByDrag,
	};
}
