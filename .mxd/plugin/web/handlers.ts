import type React from "react";
import { api } from "./api.ts";
import type { AuthFetchFn } from "./auth.ts";
import type { LogEntry, TreeNode, UIEvent } from "./hooks.ts";

type AddLogFn = (event: UIEvent) => void;

interface ActionHandlerDeps {
	authFetch: AuthFetchFn;
	projectId: string;
	selectedTaskId: string | null;
	rootNodeId: string | null;
	selectedNode: TreeNode | null;
	isOrchestratorNode: boolean;
	targetNodeId: string | null;
	clarifyAnswers: Record<string, string>;
	pendingClarifications: {
		id: string;
		taskId: string;
		question: string;
		timestamp: number;
	}[];
	// project list + add/delete managed by shell

	addLog: AddLogFn;
	setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
	setLastTurns: React.Dispatch<React.SetStateAction<number | null>>;
	setLastInputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastCacheCreationTokens: React.Dispatch<
		React.SetStateAction<number | null>
	>;
	setLastCacheReadTokens: React.Dispatch<React.SetStateAction<number | null>>;
	setLastOutputTokens: React.Dispatch<React.SetStateAction<number | null>>;
	// setProjectId removed — shell manages project selection
	// Task Y: `selectedTaskId` is URL-derived, not useState. The setter
	// routes through `pushPluginPath` internally (see Plugin.tsx). Signature
	// is just `(id, replace?) => void` — no updater-function form.
	setSelectedTaskId: (id: string | null, replace?: boolean) => void;
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
	// setCreatingProject, setNewProjectPath, setShowAddProject, setShowSettings — shell manages
	setIsCreatingTask: React.Dispatch<React.SetStateAction<boolean>>;
	setTokenUsage: React.Dispatch<
		React.SetStateAction<
			Record<string, { inputTokens: number; contextWindow: number }>
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
	// initProject — shell manages
	// deleteProject — shell manages
	refreshTasks: () => void;
	t: (key: string, params?: Record<string, string>) => string;
}

export function createActionHandlers(deps: ActionHandlerDeps) {
	const {
		authFetch,
		projectId,
		selectedTaskId,
		rootNodeId,
		selectedNode,
		isOrchestratorNode,
		targetNodeId,
		clarifyAnswers,
		pendingClarifications,
		addLog,
		setLogs,
		setLastTurns,
		setLastInputTokens,
		setLastCacheCreationTokens,
		setLastCacheReadTokens,
		setLastOutputTokens,
		setSelectedTaskId,
		setClarifyAnswers,
		setPendingClarifications,
		setIsCreatingTask,
		start,
		stop,
		compact,
		sendMessageToTask,
		deleteTask,
		stopTask,
		clearTaskSession,
		refreshTasks,
		t,
	} = deps;

	/** Handle slash commands like /compact. Returns true if handled. */
	async function handleSlashCommand(command: string): Promise<boolean> {
		const cmd = command.trim().toLowerCase();
		if (cmd === "/compact") {
			try {
				// targetNodeId === selectedTaskId post-Fix-C (root carries its
				// real id like any task). Undefined only during the brand-new
				// transient before useTasks resolves.
				const nodeId = targetNodeId ?? undefined;
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
		// /settings removed — settings is shell's responsibility (header gear icon)
		if (cmd === "/dump-messages") {
			try {
				// targetNodeId === selectedTaskId post-Fix-C.
				const nodeId = targetNodeId ?? undefined;
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
			// targetNodeId === selectedTaskId post-Fix-C. Null only during
			// the brand-new-project transient where useTasks hasn't yet
			// resolved root id. In that case bootstrap via start() — which
			// fetches root id itself and posts to it cold.
			if (targetNodeId) {
				// Unified path: all messages go through the task message endpoint.
				// For root nodes, the endpoint delegates to handleInjectMessage
				// which handles auto-launch, cold-start headers, and resume.
				await sendMessageToTask(targetNodeId, message.trim(), images);
			} else {
				// No target — start the orchestrator cold.
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

	// handleAddProject, handleDeleteProject — moved to shell

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

	return {
		handleSend,
		handleStop,
		handleClarifySubmit,
		handleClearRootSession,
		handleDeleteTask,
		handleStopTask,
		handleClearTaskSession,
		handleAddTask,
		handleCreateTask,
		handleCancelCreate,
	};
}
