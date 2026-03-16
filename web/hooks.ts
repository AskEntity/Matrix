import { useCallback, useEffect, useRef, useState } from "react";

export type { TaskNode, TaskStatus } from "../src/types.ts";

import type { TaskNode } from "../src/types.ts";

// --- Types ---

export interface Project {
	id: string;
	name: string;
	path: string;
}

export interface LogEntry {
	id: number;
	time: string;
	type: string;
	text: string;
	taskId?: string;
	/** Full checkpoint content for compact events (collapsible in UI). */
	checkpoint?: string;
	/** Structured tool fields — present for tool_use/tool_result from live WS events. */
	toolName?: string;
	/** Unique ID linking a tool_use to its tool_result (from provider's tool_use_id). */
	toolUseId?: string;
	toolArgs?: Record<string, unknown>;
	toolResult?: string;
	isError?: boolean;
	images?: { base64: string; mediaType: string }[];
	/** Structured metadata for queue message cards (parent_update, child_report, etc.) */
	meta?: Record<string, unknown>;
}

let logIdCounter = 0;

// --- useWebSocket ---

export function useWebSocket(
	projectId: string,
	onMessage: (msg: Record<string, unknown>) => void,
	onConnect?: () => void,
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
				onConnect?.();
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
	}, [projectId, onMessage, onConnect]);

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

export function useTasks(
	projectId: string,
	setRootNodeId?: React.Dispatch<React.SetStateAction<string | null>>,
) {
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
			if (data.rootNodeId && setRootNodeId) {
				setRootNodeId(data.rootNodeId);
			}
		} catch {
			/* ignore */
		}
	}, [projectId, setRootNodeId]);

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
	const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
	const running = activeAgents.size > 0;
	const [provider, setProvider] = useState<string | null>(null);
	const [model, setModel] = useState<string | null>(null);

	const checkStatus = useCallback(async () => {
		if (!projectId) {
			setActiveAgents(new Set());
			setProvider(null);
			setModel(null);
			return;
		}
		try {
			// Fetch per-agent idle/active status
			const statusRes = await fetch(`/projects/${projectId}/agent/status`);
			if (statusRes.ok) {
				const statusData = (await statusRes.json()) as {
					idle: string[];
					active: string[];
				};
				setActiveAgents(new Set(statusData.active));
			}
			// Fetch provider/model from legacy endpoint
			const res = await fetch(`/projects/${projectId}/agent`);
			const data = await res.json();
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
			// The orchestration_started WS event will add the root to activeAgents
		},
		[projectId],
	);

	const stop = useCallback(async () => {
		const res = await fetch(`/projects/${projectId}/stop`, {
			method: "POST",
		});
		if (!res.ok) {
			// 404 means session already gone — reset UI running state to match.
			if (res.status === 404) {
				setActiveAgents(new Set());
				return;
			}
			throw new Error((await res.json()).error);
		}
		// agent_stopped WS event will clear activeAgents via checkStatus
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
		async (
			message: string,
			images?: { base64: string; mediaType: string }[],
		) => {
			const body: Record<string, unknown> = { message };
			if (images?.length) body.images = images;
			const res = await fetch(`/projects/${projectId}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[projectId],
	);

	const compact = useCallback(async () => {
		const res = await fetch(`/projects/${projectId}/compact`, {
			method: "POST",
		});
		if (!res.ok) throw new Error((await res.json()).error);
	}, [projectId]);

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

	const reorderTasks = useCallback(
		async (nodeId: string, children: string[]) => {
			const res = await fetch(
				`/projects/${projectId}/tasks/${nodeId}/reorder`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ children }),
				},
			);
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[projectId],
	);

	const reparentTask = useCallback(
		async (nodeId: string, newParentId: string) => {
			const res = await fetch(`/projects/${projectId}/tasks/${nodeId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ parentId: newParentId }),
			});
			if (!res.ok) throw new Error((await res.json()).error);
		},
		[projectId],
	);

	return {
		running,
		activeAgents,
		setActiveAgents,
		provider,
		setProvider,
		model,
		setModel,
		start,
		stop,
		compact,
		checkStatus,
		continueTask,
		deleteTask,
		sendMessage,
		sendMessageToTask,
		reorderTasks,
		reparentTask,
	};
}

// --- Log helpers ---

export interface CreateLogEntryOpts {
	type: string;
	text: string;
	taskId?: string;
	checkpoint?: string;
	toolName?: string;
	toolUseId?: string;
	toolArgs?: Record<string, unknown>;
	toolResult?: string;
	isError?: boolean;
	images?: { base64: string; mediaType: string }[];
	meta?: Record<string, unknown>;
}

export function createLogEntry(opts: CreateLogEntryOpts): LogEntry {
	const entry: LogEntry = {
		id: logIdCounter++,
		time: new Date().toLocaleTimeString(),
		type: opts.type,
		text: opts.text,
		taskId: opts.taskId,
	};
	if (opts.checkpoint !== undefined) entry.checkpoint = opts.checkpoint;
	if (opts.toolName !== undefined) entry.toolName = opts.toolName;
	if (opts.toolUseId !== undefined) entry.toolUseId = opts.toolUseId;
	if (opts.toolArgs !== undefined) entry.toolArgs = opts.toolArgs;
	if (opts.toolResult !== undefined) entry.toolResult = opts.toolResult;
	if (opts.isError !== undefined) entry.isError = opts.isError;
	if (opts.images && opts.images.length > 0) entry.images = opts.images;
	if (opts.meta) entry.meta = opts.meta;
	return entry;
}

// --- useProjectConfig ---

export function useProjectConfig(projectId: string | null) {
	const [config, setConfig] = useState<Record<string, unknown>>({});

	useEffect(() => {
		if (!projectId) {
			setConfig({});
			return;
		}
		fetch(`/projects/${projectId}/config`)
			.then((r) => r.json())
			.then(setConfig)
			.catch(() => {});
	}, [projectId]);

	const updateConfig = useCallback(
		async (partial: Record<string, unknown>) => {
			if (!projectId) return;
			const res = await fetch(`/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(partial),
			});
			if (res.ok) setConfig(await res.json());
		},
		[projectId],
	);

	return { config, updateConfig };
}

// --- useThreeLayerConfig ---

export interface ThreeLayerConfig {
	global: Record<string, unknown>;
	repo: Record<string, unknown>;
	local: Record<string, unknown>;
	resolved: Record<string, unknown>;
}

export function useThreeLayerConfig(projectId: string | null) {
	const [layers, setLayers] = useState<ThreeLayerConfig>({
		global: {},
		repo: {},
		local: {},
		resolved: {},
	});
	const [loading, setLoading] = useState(false);

	const refresh = useCallback(async () => {
		if (!projectId) {
			setLayers({ global: {}, repo: {}, local: {}, resolved: {} });
			return;
		}
		setLoading(true);
		try {
			const res = await fetch(`/projects/${projectId}/config/all`);
			if (res.ok) setLayers(await res.json());
		} catch {
			/* ignore */
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const updateGlobal = useCallback(
		async (partial: Record<string, unknown>) => {
			const res = await fetch("/config/global", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(partial),
			});
			if (res.ok) await refresh();
		},
		[refresh],
	);

	const updateRepo = useCallback(
		async (partial: Record<string, unknown>) => {
			if (!projectId) return;
			const res = await fetch(`/projects/${projectId}/config/repo`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(partial),
			});
			if (res.ok) await refresh();
		},
		[projectId, refresh],
	);

	const updateLocal = useCallback(
		async (partial: Record<string, unknown>) => {
			if (!projectId) return;
			const res = await fetch(`/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(partial),
			});
			if (res.ok) await refresh();
		},
		[projectId, refresh],
	);

	return { layers, loading, refresh, updateGlobal, updateRepo, updateLocal };
}
