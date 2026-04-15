import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useAuthFetch } from "../auth.ts";
import type { TaskNode } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconCopy, IconPause, IconTrash } from "./icons.tsx";
import { StatusBadge, statusDotClass } from "./StatusBadge.tsx";

const TASK_COLORS = [
	{ name: "Bug", value: "#f85149" },
	{ name: "Feature", value: "#388bfd" },
	{ name: "Refactor", value: "#3fb950" },
	{ name: "Optimization", value: "#d29922" },
	{ name: "Research", value: "#a371f7" },
	{ name: "Chore", value: "#768390" },
];

/** Format a date as relative time: "5m ago", "2h 10m ago", "3d ago" */
function formatRelativeTime(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	const diff = Date.now() - new Date(dateStr).getTime();
	const secs = Math.floor(diff / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Format duration since a start date: "5m", "2h 10m" */
function formatRunningDuration(dateStr: string | null | undefined): string {
	if (!dateStr) return "";
	const diff = Date.now() - new Date(dateStr).getTime();
	const secs = Math.floor(diff / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	return `${hours}h ${mins % 60}m`;
}

export const TaskDetail = memo(function TaskDetail({
	node,
	projectId,
	isActive,
	onDelete,
	onStop,
	onClearSession,
	compact,
}: {
	node: TaskNode;
	projectId: string;
	isActive?: boolean;
	onDelete: () => void;
	onStop?: () => void;
	onClearSession?: () => void;
	compact?: boolean;
}) {
	const authFetch = useAuthFetch();
	const { t } = useLocale();
	const isRunning = isActive ?? node.status === "in_progress";
	const [editingTitle, setEditingTitle] = useState(false);
	const [editTitle, setEditTitle] = useState(node.title);
	const [editingDesc, setEditingDesc] = useState(false);
	const [editDesc, setEditDesc] = useState(node.description);
	const titleInputRef = useRef<HTMLInputElement>(null);
	const descTextareaRef = useRef<HTMLTextAreaElement>(null);

	// Sync local state when node changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset edit state when node identity changes
	useEffect(() => {
		setEditTitle(node.title);
		setEditDesc(node.description);
		setEditingTitle(false);
		setEditingDesc(false);
	}, [node.id]);

	const [idCopied, setIdCopied] = useState(false);
	const copyId = useCallback(() => {
		navigator.clipboard.writeText(node.id).then(() => {
			setIdCopied(true);
			setTimeout(() => setIdCopied(false), 1500);
		});
	}, [node.id]);

	const saveTitle = useCallback(
		(value: string) => {
			const trimmed = value.trim();
			if (trimmed && trimmed !== node.title) {
				authFetch(api.task(projectId, node.id), {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title: trimmed }),
				});
			}
			setEditingTitle(false);
		},
		[projectId, node.id, node.title],
	);

	const saveDescription = useCallback(
		(value: string) => {
			if (value !== node.description) {
				authFetch(api.task(projectId, node.id), {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ description: value }),
				});
			}
			setEditingDesc(false);
		},
		[projectId, node.id, node.description],
	);

	if (compact) {
		return (
			<div className="mxd-task-meta-compact">
				<div className="mxd-meta-left">
					<StatusBadge status={node.status} />
					{editingTitle ? (
						<input
							ref={titleInputRef}
							className="mxd-editable-title-input"
							style={{ fontSize: "13px" }}
							value={editTitle}
							onChange={(e) => setEditTitle(e.target.value)}
							onBlur={() => saveTitle(editTitle)}
							onKeyDown={(e) => {
								if (e.key === "Enter") saveTitle(editTitle);
								if (e.key === "Escape") {
									setEditTitle(node.title);
									setEditingTitle(false);
								}
							}}
						/>
					) : (
						<button
							type="button"
							className="mxd-editable-title"
							style={{ fontSize: "13px", fontWeight: 600 }}
							onClick={() => {
								setEditingTitle(true);
								setTimeout(() => titleInputRef.current?.focus(), 0);
							}}
							title={t("detail.clickToEdit")}
						>
							{node.title}
						</button>
					)}
					<button
						type="button"
						className="mxd-detail-task-id"
						onClick={copyId}
						title={t("detail.copyId")}
						style={{ marginBottom: 0 }}
					>
						<span className="mxd-detail-task-id-text">
							{node.id.slice(0, 12)}…
						</span>
						<IconCopy size={9} />
						{idCopied && (
							<span className="mxd-detail-id-copied">{t("detail.copied")}</span>
						)}
					</button>
				</div>
				<div className="mxd-meta-right">
					{node.branch && (
						<span className="mxd-task-branch-tag">{node.branch}</span>
					)}
					{node.costUsd > 0 && (
						<span className="mxd-meta-cost">${node.costUsd.toFixed(3)}</span>
					)}
					{isRunning && onStop && (
						<button
							type="button"
							className="mxd-btn mxd-btn-warning mxd-btn-sm"
							onClick={onStop}
						>
							<IconPause size={10} />
							{t("detail.stop")}
						</button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="mxd-detail-content">
			<div className="mxd-detail-title">
				<span
					className={`mxd-task-status-dot ${statusDotClass(node.status)}`}
					style={{ width: "10px", height: "10px", flexShrink: 0 }}
				/>
				{editingTitle ? (
					<input
						ref={titleInputRef}
						className="mxd-editable-title-input"
						value={editTitle}
						onChange={(e) => setEditTitle(e.target.value)}
						onBlur={() => saveTitle(editTitle)}
						onKeyDown={(e) => {
							if (e.key === "Enter") saveTitle(editTitle);
							if (e.key === "Escape") {
								setEditTitle(node.title);
								setEditingTitle(false);
							}
						}}
					/>
				) : (
					<button
						type="button"
						className="mxd-editable-title"
						onClick={() => {
							setEditingTitle(true);
							setTimeout(() => titleInputRef.current?.focus(), 0);
						}}
						title={t("detail.clickToEdit")}
					>
						{node.title}
					</button>
				)}
			</div>

			<button
				type="button"
				className="mxd-detail-task-id"
				onClick={copyId}
				title={t("detail.copyId")}
			>
				<span className="mxd-detail-task-id-text">{node.id}</span>
				<IconCopy size={10} />
				{idCopied && (
					<span className="mxd-detail-id-copied">{t("detail.copied")}</span>
				)}
			</button>

			{editingDesc ? (
				<textarea
					ref={descTextareaRef}
					className="mxd-editable-desc-textarea"
					value={editDesc}
					onChange={(e) => setEditDesc(e.target.value)}
					onBlur={() => saveDescription(editDesc)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							setEditDesc(node.description);
							setEditingDesc(false);
						}
					}}
					rows={8}
				/>
			) : (
				<button
					type="button"
					className="mxd-detail-description mxd-editable-desc"
					onClick={() => {
						setEditingDesc(true);
						setTimeout(() => descTextareaRef.current?.focus(), 0);
					}}
					title={t("detail.clickToEdit")}
				>
					{node.description || (
						<span className="mxd-text-faint">
							{t("detail.editDescription")}
						</span>
					)}
					{isRunning && (
						<div className="mxd-running-hint">{t("detail.runningHint")}</div>
					)}
				</button>
			)}

			<div className="mxd-detail-grid">
				<div className="mxd-detail-field">
					<div className="mxd-detail-label">{t("detail.status")}</div>
					<StatusBadge status={node.status} />
				</div>
				<div className="mxd-detail-field">
					<div className="mxd-detail-label">{t("detail.color")}</div>
					<div className="mxd-color-picker">
						{TASK_COLORS.map((c) => (
							<button
								key={c.value}
								type="button"
								className={`mxd-color-category${node.color === c.value ? " selected" : ""}`}
								onClick={() => {
									const newColor = node.color === c.value ? null : c.value;
									authFetch(api.task(projectId, node.id), {
										method: "PATCH",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({ color: newColor }),
									});
								}}
							>
								<span
									className="mxd-color-swatch"
									style={{ backgroundColor: c.value }}
								/>
								{c.name}
							</button>
						))}
						{node.color && (
							<button
								type="button"
								className="mxd-color-clear"
								title="Clear color"
								onClick={() => {
									authFetch(api.task(projectId, node.id), {
										method: "PATCH",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({ color: null }),
									});
								}}
							>
								✕
							</button>
						)}
					</div>
				</div>
				{node.branch && (
					<div className="mxd-detail-field">
						<div className="mxd-detail-label">{t("detail.branch")}</div>
						<div className="mxd-detail-value mono">{node.branch}</div>
					</div>
				)}
				{node.worktreePath && (
					<div className="mxd-detail-field">
						<div className="mxd-detail-label">{t("detail.worktree")}</div>
						<div className="mxd-detail-value mono" style={{ fontSize: "10px" }}>
							{node.worktreePath}
						</div>
					</div>
				)}
				{node.updatedAt && (
					<div className="mxd-detail-field">
						<div className="mxd-detail-label">{t("detail.updated")}</div>
						<div className="mxd-detail-value">
							{new Date(node.updatedAt).toLocaleString()}
						</div>
					</div>
				)}
				{(node.createdAt || node.updatedAt) && (
					<div className="mxd-detail-field">
						<div className="mxd-detail-label">
							{node.status === "in_progress"
								? t("detail.elapsed")
								: node.status === "pending"
									? t("detail.waiting")
									: t("detail.age")}
						</div>
						<div className="mxd-detail-value">
							{node.status === "in_progress"
								? formatRunningDuration(node.createdAt ?? node.updatedAt)
								: node.status === "pending"
									? formatRelativeTime(node.createdAt ?? node.updatedAt)
									: formatRelativeTime(node.updatedAt)}
						</div>
					</div>
				)}
				{node.costUsd > 0 || node.budgetUsd ? (
					<div className="mxd-detail-field">
						<div className="mxd-detail-label">{t("detail.cost")}</div>
						<div className="mxd-detail-value mono">
							${node.costUsd.toFixed(4)}
							{node.budgetUsd
								? ` / ${node.budgetUsd.toFixed(2)} ${t("detail.budget")}`
								: ""}
						</div>
					</div>
				) : null}
			</div>

			<div className="mxd-detail-actions">
				{isRunning && onStop && (
					<button
						type="button"
						className="mxd-btn mxd-btn-warning mxd-btn-sm"
						onClick={onStop}
					>
						<IconPause size={12} />
						{t("detail.stop")}
					</button>
				)}
				{!isRunning &&
					node.status !== "pending" &&
					node.status !== "draft" &&
					onClearSession && (
						<button
							type="button"
							className="mxd-btn mxd-btn-ghost mxd-btn-sm"
							onClick={onClearSession}
						>
							<IconTrash size={12} />
							{t("detail.clearSession")}
						</button>
					)}
				<button
					type="button"
					className="mxd-btn mxd-btn-danger mxd-btn-sm"
					onClick={onDelete}
				>
					<IconTrash size={12} />
					{t("detail.delete")}
				</button>
			</div>
		</div>
	);
});
