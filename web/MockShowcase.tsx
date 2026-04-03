/**
 * MockShowcase — standalone page for rendering all card types + task states.
 *
 * Activated by `?mock=true` in the URL. Fetches static data from `/mock-showcase`
 * and renders it using the same components as the real app.
 * No SSE, no auth, no agent controls — pure static render.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "./auth.ts";
import { ActivityLog } from "./components/ActivityLog.tsx";
import { TaskTree } from "./components/TaskTree.tsx";
import { createEventHandler, type EventHandlerDeps } from "./event-handler.ts";
import {
	type IncomingEvent,
	isTask,
	type LogEntry,
	type TreeNode,
} from "./hooks.ts";
import { useLocale } from "./i18n.ts";

interface MockData {
	nodes: TreeNode[];
	rootNodeId: string;
	events: IncomingEvent[];
}

export function MockShowcase() {
	const { t } = useLocale();

	// ── State that mirrors what AuthenticatedApp provides ──
	const [nodes, setNodes] = useState<TreeNode[]>([]);
	const [rootNodeId, setRootNodeId] = useState<string | null>(null);
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pendingMessages, setPendingMessages] = useState<
		{
			id: string;
			taskId: string | null;
			text: string;
			timestamp: number;
			images?: Array<{ base64: string; mediaType: string }>;
		}[]
	>([]);

	const nodeMap = useMemo(() => {
		const map = new Map<string, TreeNode>();
		for (const n of nodes) map.set(n.id, n);
		return map;
	}, [nodes]);

	const viewedSessionRef = useRef<string | null>(null);
	const viewedSessionId = selectedTaskId ?? rootNodeId;
	viewedSessionRef.current = viewedSessionId;

	// ── Build event handler with minimal deps ──
	const { processEventBatch } = useMemo(() => {
		const deps: EventHandlerDeps = {
			updateFromWS: () => {}, // No live updates in mock mode
			setRootNodeId,
			setActiveAgents,
			checkAgentStatus: () => {}, // No backend to check
			setAgentProvider: () => {},
			setAgentModel: () => {},
			setLogs,
			setTokenUsage: () => {},
			setPendingMessages,
			setPendingClarifications: () => {},
			setLastTurns: () => {},
			setLastInputTokens: () => {},
			setLastCacheCreationTokens: () => {},
			setLastCacheReadTokens: () => {},
			setLastOutputTokens: () => {},
			setBackgroundProcesses: () => {},
			t,
			getViewedSessionId: () => viewedSessionRef.current,
		};
		return createEventHandler(deps);
	}, [t]);

	// ── Fetch mock data on mount ──
	useEffect(() => {
		let cancelled = false;
		authFetch("/mock-showcase")
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((data: MockData) => {
				if (cancelled) return;
				setNodes(data.nodes);
				setRootNodeId(data.rootNodeId);
				processEventBatch(data.events);
				setLoading(false);
			})
			.catch((e) => {
				if (cancelled) return;
				setError(e.message);
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [processEventBatch]);

	const handleTaskSelect = useCallback((id: string | null) => {
		setSelectedTaskId(id);
	}, []);

	const isOrchestratorNode = !selectedTaskId || selectedTaskId === rootNodeId;
	const selectedNode =
		selectedTaskId && !isOrchestratorNode
			? (nodeMap.get(selectedTaskId) ?? null)
			: null;
	const filterLabel = isOrchestratorNode
		? t("orch.label")
		: selectedNode
			? selectedNode.title
			: null;

	const totalCost = useMemo(() => {
		const sum = nodes.reduce(
			(acc, n) => (isTask(n) ? acc + n.costUsd : acc),
			0,
		);
		return sum > 0 ? sum : null;
	}, [nodes]);

	// ── Render ──

	if (loading) {
		return (
			<div className="mxd-login-page">
				<div className="mxd-login-card">
					<div className="mxd-login-icon">⏳</div>
					<p className="mxd-login-subtitle">Loading mock showcase…</p>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="mxd-login-page">
				<div className="mxd-login-card">
					<div className="mxd-login-icon">❌</div>
					<p className="mxd-login-subtitle">
						Failed to load mock data: {error}
					</p>
					<p className="mxd-login-subtitle" style={{ fontSize: "11px" }}>
						Make sure the daemon is running and the /mock-showcase endpoint is
						registered.
					</p>
				</div>
			</div>
		);
	}

	return (
		<>
			{/* Simplified header for mock mode */}
			<header className="mxd-header">
				<div className="mxd-header-left">
					<span className="mxd-logo">⬡ Matrix</span>
					<span
						style={{
							fontSize: "11px",
							color: "var(--text-faint)",
							marginLeft: "8px",
						}}
					>
						Mock Showcase
					</span>
				</div>
				<div className="mxd-header-right">
					{totalCost !== null && (
						<span
							style={{
								fontSize: "11px",
								color: "var(--text-faint)",
								fontFamily: "var(--font-mono)",
							}}
						>
							${totalCost.toFixed(2)}
						</span>
					)}
				</div>
			</header>

			<main className="mxd-main">
				<aside className="mxd-sidebar">
					<div className="mxd-panel-header">
						<span className="mxd-panel-title">{t("tasks.title")}</span>
					</div>
					<TaskTree
						nodes={nodes}
						selectedTaskId={selectedTaskId}
						rootNodeId={rootNodeId}
						activeAgents={activeAgents}
						onSelect={handleTaskSelect}
					/>
				</aside>

				<section className="mxd-content">
					<div className="mxd-activity-panel" style={{ flex: 1 }}>
						<div className="mxd-panel-header">
							<span className="mxd-panel-title">
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
						</div>
						<ActivityLog
							entries={logs}
							filterTaskId={selectedTaskId}
							rootNodeId={rootNodeId}
							nodeMap={nodeMap}
							autoScroll={autoScroll}
							onAutoScrollChange={setAutoScroll}
							isActive={false}
							projectId=""
						/>
					</div>
				</section>
			</main>

			{/* Pending messages footer — shows unconsumed messages as chips */}
			{pendingMessages.length > 0 && (
				<footer
					className="mxd-footer"
					style={{
						borderTop: "1px solid var(--border)",
						padding: "6px 12px",
						display: "flex",
						gap: "6px",
						alignItems: "center",
						flexWrap: "wrap",
					}}
				>
					<span
						style={{
							fontSize: "10px",
							color: "var(--text-faint)",
							textTransform: "uppercase",
							letterSpacing: "0.5px",
							fontWeight: 600,
						}}
					>
						Pending
					</span>
					{pendingMessages.map((msg) => (
						<span
							key={msg.id}
							className="mxd-pending-chip"
							style={{
								fontSize: "11px",
								padding: "2px 8px",
								borderRadius: "10px",
								background: "var(--bg-elevated)",
								border: "1px solid var(--border)",
								color: "var(--text-secondary)",
								maxWidth: "200px",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							}}
						>
							{msg.text}
						</span>
					))}
				</footer>
			)}
		</>
	);
}
