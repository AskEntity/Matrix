import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createLogEntry,
	type LogEntry,
	type TaskNode,
	useAgent,
	useProjects,
	useTasks,
	useWebSocket,
} from "./hooks.ts";

const PROJECT_NODE_ID = "__project__";

// --- Task Tree Component ---

function TaskTree({
	nodes,
	selectedTaskId,
	onSelect,
}: {
	nodes: TaskNode[];
	selectedTaskId: string | null;
	onSelect: (id: string | null) => void;
}) {
	const roots = useMemo(() => nodes.filter((n) => !n.parentId), [nodes]);
	const childMap = useMemo(() => {
		const map = new Map<string, TaskNode[]>();
		for (const n of nodes) {
			if (n.parentId) {
				if (!map.has(n.parentId)) map.set(n.parentId, []);
				map.get(n.parentId)?.push(n);
			}
		}
		return map;
	}, [nodes]);

	const isProjectSelected = selectedTaskId === PROJECT_NODE_ID;

	return (
		<div className="task-tree">
			<button
				type="button"
				className={`task-node project-node${isProjectSelected ? " selected" : ""}`}
				onClick={(e) => {
					e.stopPropagation();
					onSelect(isProjectSelected ? null : PROJECT_NODE_ID);
				}}
			>
				<div className="task-row" style={{ paddingLeft: "14px" }}>
					<span className="project-icon">⬡</span>
					<span className="task-title">Orchestrator</span>
				</div>
			</button>
			{roots.map((root) => (
				<TaskNodeView
					key={root.id}
					node={root}
					childMap={childMap}
					depth={1}
					selectedTaskId={selectedTaskId}
					onSelect={onSelect}
				/>
			))}
			{nodes.length === 0 && <div className="empty-state">No tasks yet.</div>}
		</div>
	);
}

function TaskNodeView({
	node,
	childMap,
	depth,
	selectedTaskId,
	onSelect,
}: {
	node: TaskNode;
	childMap: Map<string, TaskNode[]>;
	depth: number;
	selectedTaskId: string | null;
	onSelect: (id: string | null) => void;
}) {
	const isSelected = node.id === selectedTaskId;
	const children = childMap.get(node.id) || [];

	return (
		<>
			<button
				type="button"
				className={`task-node${isSelected ? " selected" : ""}`}
				onClick={(e) => {
					e.stopPropagation();
					onSelect(isSelected ? null : node.id);
				}}
			>
				<div
					className="task-row"
					style={{ paddingLeft: `${14 + depth * 16}px` }}
				>
					<span className={`task-status status-${node.status}`} />
					<span className="task-title">{node.title}</span>
					{node.branch && (
						<span className="task-branch">
							{node.branch.replace("og/", "")}
						</span>
					)}
				</div>
			</button>
			{children.map((child) => (
				<TaskNodeView
					key={child.id}
					node={child}
					childMap={childMap}
					depth={depth + 1}
					selectedTaskId={selectedTaskId}
					onSelect={onSelect}
				/>
			))}
		</>
	);
}

// --- Activity Log ---

function ActivityLog({
	entries,
	filterTaskId,
	nodeMap,
}: {
	entries: LogEntry[];
	filterTaskId: string | null;
	nodeMap: Map<string, TaskNode>;
}) {
	const logRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new entries
	useEffect(() => {
		if (logRef.current) {
			logRef.current.scrollTop = logRef.current.scrollHeight;
		}
	}, [entries.length]);

	const visible = useMemo(() => {
		if (!filterTaskId) return entries;

		// Project node: show only orchestrator-level events (no taskId)
		if (filterTaskId === PROJECT_NODE_ID) {
			return entries.filter((e) => !e.taskId);
		}

		// Real task: show events for this task and all its descendants
		const descendantIds = new Set<string>();
		const collect = (id: string) => {
			descendantIds.add(id);
			const node = nodeMap.get(id);
			if (node?.children) {
				for (const childId of node.children) {
					collect(childId);
				}
			}
		};
		collect(filterTaskId);

		return entries.filter((e) => e.taskId && descendantIds.has(e.taskId));
	}, [entries, filterTaskId, nodeMap]);

	return (
		<div className="activity-log" ref={logRef}>
			{visible.map((entry) => (
				<LogEntryView key={entry.id} entry={entry} nodeMap={nodeMap} />
			))}
		</div>
	);
}

function LogEntryView({
	entry,
	nodeMap,
}: {
	entry: LogEntry;
	nodeMap: Map<string, TaskNode>;
}) {
	const [expanded, setExpanded] = useState(false);
	const taskLabel = entry.taskId
		? (nodeMap.get(entry.taskId)?.title?.slice(0, 16) ??
			entry.taskId.slice(0, 8))
		: null;

	if (entry.type === "compact" && entry.checkpoint) {
		return (
			<div className="compact-boundary">
				<div className="compact-faded-hint">
					Content above this line is not visible to the agent
				</div>
				<div className="compact-divider">
					<span className="compact-label">{entry.text}</span>
					<button
						type="button"
						className="compact-toggle"
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? "▼ Collapse" : "▶ Show checkpoint"}
					</button>
				</div>
				{expanded && (
					<pre className="compact-checkpoint">{entry.checkpoint}</pre>
				)}
			</div>
		);
	}

	return (
		<div className={`log-entry event-${entry.type}`}>
			<span className="log-time">{entry.time}</span>
			{taskLabel && (
				<span className="log-task-badge" title={entry.taskId}>
					{taskLabel}
				</span>
			)}
			<span className="log-text">{entry.text}</span>
		</div>
	);
}

// --- Inline Task Detail (shown in content area) ---

function ContentDetail({
	node,
	onContinue,
	onDelete,
}: {
	node: TaskNode;
	onContinue: (msg?: string) => void;
	onDelete: () => void;
}) {
	const [continueMsg, setContinueMsg] = useState("");

	return (
		<div className="content-detail">
			<h2>{node.title}</h2>
			{node.description && (
				<div className="detail-value desc">{node.description}</div>
			)}
			<div className="content-detail-fields">
				<div className="detail-field">
					<div className="detail-label">Status</div>
					<span className={`status-badge ${node.status}`}>{node.status}</span>
				</div>
				{node.branch && (
					<div className="detail-field">
						<div className="detail-label">Branch</div>
						<div className="detail-value mono">{node.branch}</div>
					</div>
				)}
				{node.worktreePath && (
					<div className="detail-field">
						<div className="detail-label">Worktree</div>
						<div className="detail-value mono">{node.worktreePath}</div>
					</div>
				)}
				{node.updatedAt && (
					<div className="detail-field">
						<div className="detail-label">Updated</div>
						<div className="detail-value">
							{new Date(node.updatedAt).toLocaleString()}
						</div>
					</div>
				)}
				{node.message && (
					<div className="detail-field">
						<div className="detail-label">Message</div>
						<div className="detail-value">{node.message}</div>
					</div>
				)}
			</div>
			<div className="content-detail-actions">
				{(node.status === "failed" || node.status === "stuck") && (
					<form
						className="continue-form"
						onSubmit={(e) => {
							e.preventDefault();
							onContinue(continueMsg || undefined);
							setContinueMsg("");
						}}
					>
						<input
							type="text"
							value={continueMsg}
							onChange={(e) => setContinueMsg(e.target.value)}
							placeholder="Instructions for the agent..."
						/>
						<button type="submit" className="btn-continue">
							Continue
						</button>
					</form>
				)}
				<button
					type="button"
					className="btn-danger btn-small"
					onClick={onDelete}
				>
					Delete
				</button>
			</div>
		</div>
	);
}

// --- Main App ---

export function App() {
	const { projects, refresh: refreshProjects } = useProjects();
	const [projectId, setProjectId] = useState("");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [childModel, setChildModel] = useState("");
	const [splitRatio, setSplitRatio] = useState(0.5);
	const [isDragging, setIsDragging] = useState(false);
	const contentPanelRef = useRef<HTMLElement>(null);

	const { nodes, refresh: refreshTasks, updateFromWS } = useTasks(projectId);
	const {
		running,
		setRunning,
		start,
		stop,
		checkStatus,
		continueTask,
		deleteTask,
		sendMessage,
	} = useAgent(projectId);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TaskNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	const isProjectNode = selectedTaskId === PROJECT_NODE_ID;
	const selectedNode =
		selectedTaskId && !isProjectNode
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

	// Draggable divider handlers
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
			const y = e.clientY - rect.top;
			const ratio = Math.min(0.85, Math.max(0.15, y / rect.height));
			setSplitRatio(ratio);
		};
		const handleMouseUp = () => {
			setIsDragging(false);
		};
		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);
		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging]);

	// WebSocket message handler
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
						text = `${msg.isError ? "ERR" : "OK"} ${msg.tool}: ${((msg.content as string) || "").slice(0, 150)}`;
					} else if (et === "text") {
						text = (msg.content as string) || "";
					} else if (et === "error") {
						text = (msg.message as string) || "";
					} else if (et === "compact") {
						text = `Context compacted (saved ~${msg.savedTokens} tokens)`;
						addLog(
							et,
							text,
							msg.taskId as string | undefined,
							msg.checkpoint as string,
						);
						break;
					} else if (et === "status") {
						text = (msg.message as string) || "";
					} else {
						text = JSON.stringify(msg).slice(0, 200);
					}
					addLog(et, text, msg.taskId as string | undefined);
					break;
				}
				case "orchestration_started":
					addLog("lifecycle", "Orchestration started");
					setRunning(true);
					break;
				case "orchestration_completed":
					addLog(
						"lifecycle",
						`Orchestration ${msg.success ? "completed" : "failed"}${msg.costUsd ? ` ($${(msg.costUsd as number).toFixed(2)})` : ""}`,
					);
					setRunning(false);
					break;
				case "agent_stopped":
					addLog("lifecycle", "Agent stopped");
					setRunning(false);
					break;
				case "task_started":
					addLog("task_started", `Started: ${msg.title}`, msg.taskId as string);
					break;
				case "task_completed":
					addLog(
						"task_completed",
						`${msg.success ? "Passed" : "Failed"}: ${msg.title}`,
						msg.taskId as string,
					);
					break;
				case "error":
					addLog("error", msg.message as string);
					break;
				case "event_history": {
					// Clear and replay historical events on connect
					setLogs([]);
					const events = msg.events as Record<string, unknown>[];
					for (const evt of events) {
						handleWS(evt);
					}
					break;
				}
			}
		},
		[addLog, updateFromWS, setRunning],
	);

	const { connected } = useWebSocket(projectId, handleWS);

	// Auto-select first project
	useEffect(() => {
		if (projects.length > 0 && !projectId && projects[0]) {
			setProjectId(projects[0].id);
		}
	}, [projects, projectId]);

	// Check agent status on project change
	useEffect(() => {
		if (projectId) checkStatus();
	}, [projectId, checkStatus]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!prompt.trim() || !projectId) return;
		try {
			if (running) {
				await sendMessage(prompt.trim());
				addLog("lifecycle", `Message sent: ${prompt.trim()}`);
			} else {
				await start({
					prompt: prompt.trim(),
					model: model || undefined,
					childModel: childModel || undefined,
				});
			}
			setPrompt("");
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

	async function handleContinueTask(msg?: string) {
		if (!selectedTaskId) return;
		try {
			await continueTask(selectedTaskId, msg);
			addLog(
				"task_started",
				`Continued: ${selectedNode?.title}`,
				selectedTaskId,
			);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleDeleteTask() {
		if (!selectedTaskId || !selectedNode) return;
		if (!confirm(`Delete task "${selectedNode.title}"?`)) return;
		try {
			await deleteTask(selectedTaskId);
			addLog("lifecycle", `Deleted: ${selectedNode.title}`);
			setSelectedTaskId(null);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	async function handleAddTask() {
		if (!projectId) return;
		const title = window.prompt("Task title:");
		if (!title) return;
		const description = window.prompt("Description:") || "";
		const body: Record<string, string> = { title, description };
		if (selectedTaskId) body.parentId = selectedTaskId;
		try {
			const res = await fetch(`/projects/${projectId}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) throw new Error((await res.json()).error);
			await refreshTasks();
		} catch (err) {
			addLog("error", (err as Error).message);
		}
	}

	return (
		<>
			{/* Header */}
			<header>
				<div className="header-left">
					<span className="brand-icon">⬡</span>
					<h1>OpenGraft</h1>
					<span
						className={`status-dot ${connected ? "connected" : "disconnected"}`}
						title={connected ? "Connected" : "Disconnected"}
					/>
				</div>
				<div className="header-right">
					<select
						value={projectId}
						onChange={(e) => {
							setProjectId(e.target.value);
							setSelectedTaskId(null);
							setLogs([]);
						}}
					>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</div>
			</header>

			{/* Main */}
			<main>
				{/* Left: Task Panel */}
				<section className="task-panel">
					<div className="section-bar">
						<span className="section-title">Tasks</span>
						<div className="section-actions">
							{selectedTaskId && (
								<>
									<span className="filter-badge">
										{isProjectNode
											? "Orchestrator"
											: (selectedNode?.title?.slice(0, 20) ?? "") +
												((selectedNode?.title?.length ?? 0) > 20 ? "..." : "")}
									</span>
									<button
										type="button"
										className="btn-small"
										onClick={() => setSelectedTaskId(null)}
										title="Clear filter"
									>
										All
									</button>
								</>
							)}
							<button
								type="button"
								className="btn-small"
								onClick={handleAddTask}
								title="Add task"
							>
								+
							</button>
							<button
								type="button"
								className="btn-small"
								onClick={() => {
									refreshTasks();
									refreshProjects();
								}}
								title="Refresh"
							>
								↻
							</button>
						</div>
					</div>
					<TaskTree
						nodes={nodes}
						selectedTaskId={selectedTaskId}
						onSelect={setSelectedTaskId}
					/>
				</section>

				{/* Right: Content Area (status + activity, split vertically) */}
				<section
					className={`content-panel${isDragging ? " dragging" : ""}`}
					ref={contentPanelRef}
				>
					{/* Top: STATUS */}
					<div className="content-status-panel" style={{ flex: splitRatio }}>
						<div className="section-bar">
							<span className="section-title">Status</span>
						</div>
						{isProjectNode ? (
							<div className="content-detail">
								<h2>
									<span className="project-icon">⬡</span> Orchestrator
								</h2>
								<div className="content-detail-fields">
									<div className="detail-field">
										<div className="detail-label">Status</div>
										<span
											className={`status-badge ${running ? "in_progress" : "idle"}`}
										>
											{running ? "running" : "idle"}
										</span>
									</div>
									<div className="detail-field">
										<div className="detail-label">Tasks</div>
										<div className="detail-value">{nodes.length}</div>
									</div>
								</div>
							</div>
						) : selectedNode ? (
							<ContentDetail
								node={selectedNode}
								onContinue={handleContinueTask}
								onDelete={handleDeleteTask}
							/>
						) : (
							<div className="content-empty">Select a task to view details</div>
						)}
					</div>

					{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-only resize divider */}
					<div
						className="resize-divider"
						onMouseDown={handleDividerMouseDown}
					/>

					{/* Bottom: ACTIVITY */}
					<div className="activity-panel" style={{ flex: 1 - splitRatio }}>
						<div className="section-bar">
							<span className="section-title">
								Activity
								{isProjectNode
									? " — Orchestrator"
									: selectedNode
										? ` — ${selectedNode.title}`
										: ""}
							</span>
						</div>
						<ActivityLog
							entries={logs}
							filterTaskId={selectedTaskId}
							nodeMap={nodeMap}
						/>
					</div>
				</section>
			</main>

			{/* Footer */}
			<footer>
				<form onSubmit={handleSubmit} className="prompt-form">
					<input
						type="text"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={
							running ? "Send message to agent..." : "Describe what to build..."
						}
						disabled={!projectId}
					/>
					<div className="footer-controls">
						<select
							value={model}
							onChange={(e) => setModel(e.target.value)}
							title="Model"
						>
							<option value="">Model</option>
							<option value="claude-sonnet-4-6">Sonnet</option>
							<option value="claude-opus-4-6">Opus</option>
							<option value="claude-haiku-4-5-20251001">Haiku</option>
						</select>
						<select
							value={childModel}
							onChange={(e) => setChildModel(e.target.value)}
							title="Child model"
						>
							<option value="">Child</option>
							<option value="claude-sonnet-4-6">Sonnet</option>
							<option value="claude-opus-4-6">Opus</option>
							<option value="claude-haiku-4-5-20251001">Haiku</option>
						</select>
						{running ? (
							<>
								<button
									type="submit"
									disabled={!projectId || !prompt.trim()}
									className="btn-run"
								>
									Send
								</button>
								<button type="button" onClick={handleStop} className="btn-stop">
									Stop
								</button>
							</>
						) : (
							<button
								type="submit"
								disabled={!projectId || !prompt.trim()}
								className="btn-run"
							>
								Run
							</button>
						)}
					</div>
				</form>
			</footer>
		</>
	);
}

function formatArgs(input: Record<string, unknown> | undefined): string {
	if (!input) return "";
	const parts = Object.entries(input).map(([k, v]) => {
		const val = typeof v === "string" ? v : JSON.stringify(v);
		return `${k}=${val.length > 30 ? `${val.slice(0, 30)}...` : val}`;
	});
	const joined = parts.join(", ");
	return joined.length > 80 ? `${joined.slice(0, 80)}...` : joined;
}
