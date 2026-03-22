import { memo, useCallback, useEffect, useState } from "react";
import { authFetch } from "../auth.ts";

interface BackgroundProcess {
	id: string;
	command: string;
	startTime: number;
	taskId?: string;
}

function formatElapsed(ms: number): string {
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remainSecs = secs % 60;
	return `${mins}m${remainSecs}s`;
}

export const BackgroundProcessBar = memo(function BackgroundProcessBar({
	processes,
	projectId,
	filterTaskId,
	rootNodeId,
}: {
	processes: Map<string, BackgroundProcess>;
	projectId: string;
	filterTaskId: string | null;
	rootNodeId: string | null;
}) {
	const [now, setNow] = useState(Date.now());
	const [killing, setKilling] = useState<Set<string>>(new Set());

	// Filter to processes relevant to the current view
	const isRootView = !filterTaskId || filterTaskId === rootNodeId;
	const visible = Array.from(processes.values()).filter((p) =>
		isRootView
			? !p.taskId || p.taskId === rootNodeId
			: p.taskId === filterTaskId,
	);

	// Live elapsed time ticker
	useEffect(() => {
		if (visible.length === 0) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [visible.length]);

	const handleKill = useCallback(
		async (bgId: string, taskId?: string) => {
			setKilling((prev) => new Set(prev).add(bgId));
			try {
				await authFetch(`/projects/${projectId}/background/${bgId}/kill`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sessionId: taskId ?? rootNodeId ?? "",
					}),
				});
			} catch {
				// ignore — process may have already completed
			} finally {
				setKilling((prev) => {
					const next = new Set(prev);
					next.delete(bgId);
					return next;
				});
			}
		},
		[projectId, rootNodeId],
	);

	if (visible.length === 0) return null;

	return (
		<div className="og-background-bar">
			<span className="og-background-label">⚙ Background</span>
			{visible.map((p) => (
				<div key={p.id} className="og-background-item">
					<span className="og-background-id">{p.id}</span>
					<span className="og-background-command">
						{p.command.length > 40 ? `${p.command.slice(0, 40)}…` : p.command}
					</span>
					<span className="og-background-elapsed">
						{formatElapsed(now - p.startTime)}
					</span>
					<button
						type="button"
						className="og-background-kill"
						onClick={() => handleKill(p.id, p.taskId)}
						disabled={killing.has(p.id)}
						title="Kill process"
					>
						✕
					</button>
				</div>
			))}
		</div>
	);
});
