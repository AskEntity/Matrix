import type React from "react";
import type { LogEntry, Project, TaskNode } from "./hooks.ts";

type AddLogFn = (
	type: string,
	text: string,
	taskId?: string,
	checkpoint?: string,
) => void;

export interface ActionHandlerDeps {
	projectId: string;
	selectedTaskId: string | null;
	rootNodeId: string | null;
	selectedNode: TaskNode | null;
	isOrchestratorNode: boolean;
	prompt: string;
	targetNodeId: string | null;
	attachedImages: { base64: string; mediaType: string }[];
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
	lastSubmittedImagesRef: React.MutableRefObject<
		{ base64: string; mediaType: string }[] | undefined
	>;

	addLog: AddLogFn;
	setPrompt: React.Dispatch<React.SetStateAction<string>>;
	setAttachedImages: React.Dispatch<
		React.SetStateAction<{ base64: string; mediaType: string }[]>
	>;
	setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
	setLastCostUsd: React.Dispatch<React.SetStateAction<number | null>>;
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
	sendMessage: (
		msg: string,
		images?: { base64: string; mediaType: string }[],
	) => Promise<void>;
	sendMessageToTask: (taskId: string, msg: string) => Promise<void>;
	deleteTask: (taskId: string) => Promise<void>;
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
		prompt,
		targetNodeId,
		attachedImages,
		clarifyAnswers,
		pendingClarifications,
		newProjectPath,
		creatingProject,
		projects,
		lastSubmittedImagesRef,
		addLog,
		setPrompt,
		setAttachedImages,
		setLogs,
		setLastCostUsd,
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
		sendMessage,
		sendMessageToTask,
		deleteTask,
		initProject,
		deleteProject,
		refreshTasks,
		t,
	} = deps;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!prompt.trim() || !projectId) return;
		const images = attachedImages.length > 0 ? attachedImages : undefined;
		try {
			if (targetNodeId) {
				// Sending to a specific child task
				await sendMessageToTask(targetNodeId, prompt.trim());
			} else {
				// Unified path: always try sendMessage first (handles active and no-session).
				// Falls back to start() only if sendMessage returns 404 (no project).
				try {
					lastSubmittedImagesRef.current = images;
					await sendMessage(prompt.trim(), images);
				} catch (msgErr) {
					// sendMessage failed — likely no session exists yet. Start a new one.
					if (
						(msgErr as Error).message?.includes("not found") ||
						(msgErr as Error).message?.includes("No active session")
					) {
						lastSubmittedImagesRef.current = images;
						await start({ prompt: prompt.trim() });
					} else {
						throw msgErr;
					}
				}
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

	function handleCancelCreate() {
		setIsCreatingTask(false);
	}

	async function handleDeleteTaskByDrag(taskId: string) {
		if (!projectId) return;
		try {
			await deleteTask(taskId);
			addLog("lifecycle", `${t("lifecycle.deleted")} ${taskId}`);
			if (selectedTaskId === taskId) setSelectedTaskId(rootNodeId);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	return {
		handleSubmit,
		handleStop,
		handleClarifySubmit,
		handleClearSessions,
		handleDeleteTask,
		handlePauseTask,
		handleAddProject,
		handleDeleteProject,
		handleAddTask,
		handleCreateTask,
		handleCancelCreate,
		handleDeleteTaskByDrag,
	};
}
