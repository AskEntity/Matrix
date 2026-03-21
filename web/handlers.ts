import type React from "react";
import { authFetch } from "./auth.ts";
import type { LogEntry, Project, TaskNode, UIEvent } from "./hooks.ts";

type AddLogFn = (event: UIEvent) => void;

export interface ActionHandlerDeps {
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
	setCreatingProject: React.Dispatch<React.SetStateAction<boolean>>;
	setNewProjectPath: React.Dispatch<React.SetStateAction<string>>;
	setShowAddProject: React.Dispatch<React.SetStateAction<boolean>>;
	setIsCreatingTask: React.Dispatch<React.SetStateAction<boolean>>;

	start: (opts: { prompt: string }) => Promise<void>;
	stop: () => Promise<void>;
	compact: () => Promise<void>;
	sendMessage: (
		msg: string,
		images?: { base64: string; mediaType: string }[],
	) => Promise<void>;
	sendMessageToTask: (taskId: string, msg: string) => Promise<void>;
	deleteTask: (taskId: string) => Promise<void>;
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
		setCreatingProject,
		setNewProjectPath,
		setShowAddProject,
		setIsCreatingTask,
		start,
		stop,
		compact,
		sendMessage,
		sendMessageToTask,
		deleteTask,
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
				await compact();
			} catch (err) {
				addLog({
					type: "error",
					message: (err as Error).message,
					ts: Date.now(),
				});
			}
			return true;
		}
		if (cmd === "/clear") {
			if (!confirm(t("confirm.clearSessions"))) return true;
			try {
				const res = await authFetch(`/projects/${projectId}/sessions/clear`, {
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
			if (targetNodeId) {
				// Sending to a specific child task
				await sendMessageToTask(targetNodeId, message.trim());
			} else {
				// Unified path: always try sendMessage first (handles active and no-session).
				// Falls back to start() only if sendMessage returns 404 (no project).
				try {
					await sendMessage(message.trim(), images);
				} catch (msgErr) {
					// sendMessage failed — likely no session exists yet. Start a new one.
					if (
						(msgErr as Error).message?.includes("not found") ||
						(msgErr as Error).message?.includes("No active session")
					) {
						await start({ prompt: message.trim() });
					} else {
						throw msgErr;
					}
				}
			}
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
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
			const res = await authFetch(`/projects/${projectId}/clarify`, {
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
					ts: Date.now(),
				});
				return;
			}
			setClarifyAnswers((prev) => {
				const next = { ...prev };
				delete next[clarificationId];
				return next;
			});
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
				ts: Date.now(),
			});
		}
	}

	async function handleClearSessions() {
		if (!confirm(t("confirm.clearSessions"))) return;
		try {
			const res = await authFetch(`/projects/${projectId}/sessions/clear`, {
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
				ts: Date.now(),
			});
		}
	}

	async function handlePauseTask() {
		if (!selectedTaskId) return;
		try {
			await sendMessageToTask(
				selectedTaskId,
				"PAUSED by user. Please call yield() and wait for further instructions before continuing.",
			);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
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
			setNewProjectPath("");
			setShowAddProject(false);
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
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
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
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
			const res = await authFetch(`/projects/${projectId}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok)
				throw new Error(((await res.json()) as { error: string }).error);
			await refreshTasks();
		} catch (err) {
			addLog({
				type: "error",
				message: (err as Error).message,
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
				ts: Date.now(),
			});
		}
	}

	return {
		handleSend,
		handleStop,
		handleClarifySubmit,
		handleClearSessions,
		handleDeleteTask,
		handlePauseTask,
		handleClearTaskSession,
		handleAddProject,
		handleDeleteProject,
		handleAddTask,
		handleCreateTask,
		handleCancelCreate,
		handleDeleteTaskByDrag,
	};
}
