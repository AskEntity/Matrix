import { useCallback, useEffect, useRef, useState } from "react";

// --- Types ---

export interface Project {
	id: string;
	name: string;
	path: string;
}

export interface TaskNode {
	id: string;
	title: string;
	description: string;
	status: string;
	parentId: string | null;
	children: string[];
	branch: string | null;
	worktreePath: string | null;
	sessionId: string | null;
	message: string | null;
	costUsd?: number;
	budgetUsd?: number;
	createdAt?: string | null;
	updatedAt: string | null;
}

export interface LogEntry {
	id: number;
	time: string;
	type: string;
	text: string;
	taskId?: string;
	/** Full checkpoint content for compact events (collapsible in UI). */
	checkpoint?: string;
}

let logIdCounter = 0;

// --- useWebSocket ---

export function useWebSocket(
	projectId: string,
	onMessage: (msg: Record<string, unknown>) => void,
) {
	const wsRef = useRef<WebSocket | null>(null);
	const [connected, setConnected] = useState(false);
	const [lastMessageAt, setLastMessageAt] = useState<Date | null>(null);

	useEffect(() => {
		let delay = 1000;
		let stopped = false;

		function connect() {
			if (stopped) return;
			const protocol = location.protocol === "https:" ? "wss:" : "ws:";
			const ws = new WebSocket(`${protocol}//${location.host}/ws`);
			wsRef.current = ws;

			ws.onopen = () => {
				setConnected(true);
				delay = 1000;
				if (projectId) {
					ws.send(JSON.stringify({ type: "subscribe", projectId }));
				}
			};

			ws.onmessage = (evt) => {
				try {
					setLastMessageAt(new Date());
					onMessage(JSON.parse(evt.data));
				} catch {
					/* ignore */
				}
			};

			ws.onclose = () => {
				setConnected(false);
				if (!stopped) {
					setTimeout(connect, delay);
					delay = Math.min(delay * 2, 30000);
				}
			};

			ws.onerror = () => ws.close();
		}

		connect();

		return () => {
			stopped = true;
			wsRef.current?.close();
		};
	}, [projectId, onMessage]);

	// Subscribe when projectId changes
	useEffect(() => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN && projectId) {
			ws.send(JSON.stringify({ type: "subscribe", projectId }));
		}
	}, [projectId]);

	return { connected, lastMessageAt };
}

// --- useProjects ---

export function useProjects() {
	const [projects, setProjects] = useState<Project[]>([]);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/projects");
			setProjects(await res.json());
		} catch {
			/* ignore */
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const initProject = useCallback(
		async (path: string) => {
			const res = await fetch("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path }),
			});
			if (!res.ok) throw new Error((await res.json()).error);
			const project = await res.json();
			await refresh();
			return project as Project;
		},
		[refresh],
	);

	const deleteProject = useCallback(
		async (id: string) => {
			const res = await fetch(`/projects/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error((await res.json()).error);
			await refresh();
		},
		[refresh],
	);

	return { projects, refresh, initProject, deleteProject };
}

// --- useTasks ---

export function useTasks(projectId: string) {
	const [nodes, setNodes] = useState<TaskNode[]>([]);

	const refresh = useCallback(async () => {
		if (!projectId) {
			setNodes([]);
			return;
		}
		try {
			const res = await fetch(`/projects/${projectId}/tasks`);
			const data = await res.json();
			setNodes(data.nodes || []);
		} catch {
			/* ignore */
		}
	}, [projectId]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const updateFromWS = useCallback((wsNodes: TaskNode[]) => {
		setNodes(wsNodes);
	}, []);

	return { nodes, refresh, updateFromWS };
}

// --- useAgent ---

export function useAgent(projectId: string) {
	const [running, setRunning] = useState(false);
	const [provider, setProvider] = useState<string | null>(null);
	const [model, setModel] = useState<string | null>(null);

	const checkStatus = useCallback(async () => {
		if (!projectId) {
			setRunning(false);
			setProvider(null);
			setModel(null);
			return;
		}
		try {
			const res = await fetch(`/projects/${projectId}/agent`);
			const data = await res.json();
			setRunning(data.running);
			if (data.provider) setProvider(data.provider);
			if (data.model) setModel(data.model);
		} catch {
			/* ignore */
		}
	}, [projectId]);

	useEffect(() => {
		checkStatus();
	}, [checkStatus]);

	const start = useCallback(
		async (opts: { prompt: string; model?: string; childModel?: string }) => {
			const res = await fetch(`/projects/${projectId}/orchestrate/agent`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(opts),
			});
			if (!res.ok) throw new Error((await res.json()).error);
			setRunning(true);
		},
		[projectId],
	);

	const stop = useCallback(async () => {
		const res = await fetch(`/projects/${projectId}/stop`, {
			method: "POST",
		});
		if (!res.ok) throw new Error((await res.json()).error);
		setRunning(false);
	}, [projectId]);

	const continueTask = useCallback(
		async (taskId: string, message?: string) => {
			const body: Record<string, unknown> = {};
			if (message) body.message = message;
			const res = await fetch(
				`/projects/${projectId}/tasks/${taskId}/continue`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			if (!res.ok) throw new Error((await res.json()).error);
			return await res.json();
		},
		[projectId],
	);

	const deleteTask = useCallback(
		async (taskId: string) => {
			const res = await fetch(`/projects/${projectId}/tasks/${taskId}`, {
				method: "DELETE",
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[projectId],
	);

	const sendMessage = useCallback(
		async (message: string) => {
			const res = await fetch(`/projects/${projectId}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message }),
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[projectId],
	);

	const sendMessageToTask = useCallback(
		async (taskId: string, content: string) => {
			const res = await fetch(
				`/projects/${projectId}/tasks/${taskId}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content }),
				},
			);
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[projectId],
	);

	return {
		running,
		setRunning,
		provider,
		setProvider,
		model,
		setModel,
		start,
		stop,
		checkStatus,
		continueTask,
		deleteTask,
		sendMessage,
		sendMessageToTask,
	};
}

// --- Log helpers ---

export function createLogEntry(
	type: string,
	text: string,
	taskId?: string,
): LogEntry {
	return {
		id: logIdCounter++,
		time: new Date().toLocaleTimeString(),
		type,
		text,
		taskId,
	};
}
