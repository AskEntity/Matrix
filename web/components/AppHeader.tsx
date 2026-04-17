import { useAuthFetch } from "@mxd/auth-context";
import type React from "react";
import { memo, useEffect, useState } from "react";
import { useLocale } from "../i18n.ts";
import {
	IconClose,
	IconGear,
	IconHexagon,
	IconLogout,
	IconPlus,
} from "../icons.tsx";
import type { Project } from "./types.ts";

export const AppHeader = memo(function AppHeader({
	connected,
	projects,
	projectId,
	showAddProject,
	newProjectPath,
	creatingProject,
	showSettings,
	onProjectChange,
	onShowAddProject,
	onAddProject,
	onNewProjectPathChange,
	onCancelAddProject,
	onToggleSettings,
	onLogout,
	scopes,
	selectedScope,
	onScopeChange,
}: {
	connected: boolean;
	projects: Project[];
	projectId: string;
	showAddProject: boolean;
	newProjectPath: string;
	creatingProject: boolean;
	showSettings: boolean;
	onProjectChange: (id: string) => void;
	onShowAddProject: () => void;
	onAddProject: (e: React.FormEvent) => void;
	onNewProjectPathChange: (path: string) => void;
	onCancelAddProject: () => void;
	onToggleSettings: () => void;
	onLogout?: () => void;
	scopes?: { name: string }[];
	selectedScope?: string;
	onScopeChange?: (scope: string) => void;
}) {
	const authFetch = useAuthFetch();
	const { t } = useLocale();
	const [versionInfo, setVersionInfo] = useState<string>("");

	useEffect(() => {
		authFetch("/version")
			.then((r) => r.json())
			.then((data: { version?: string; gitHash?: string }) => {
				const hash =
					data.gitHash && data.gitHash !== "unknown"
						? ` (${data.gitHash})`
						: "";
				setVersionInfo(`v${data.version ?? "?"}${hash}`);
			})
			.catch((e) => console.warn("[AppHeader] Failed to fetch version:", e));
	}, [authFetch]);

	return (
		<header className="mxd-header">
			<div className="mxd-header-brand">
				<div className="mxd-logo">
					<IconHexagon size={14} />
				</div>
				<span className="mxd-header-title">{t("header.title")}</span>
				{versionInfo && (
					<span
						style={{
							fontSize: "10px",
							color: "var(--text-faint)",
							marginLeft: "4px",
						}}
					>
						{versionInfo}
					</span>
				)}
				<div className={`mxd-connection-badge${connected ? " connected" : ""}`}>
					<span className="mxd-connection-dot" />
					{connected ? t("header.connected") : t("header.disconnected")}
				</div>
			</div>

			<div className="mxd-header-right">
				{showAddProject ? (
					<form
						onSubmit={onAddProject}
						style={{ display: "flex", alignItems: "center", gap: "6px" }}
					>
						<input
							className="mxd-continue-input"
							type="text"
							placeholder={t("project.pathPlaceholder")}
							value={newProjectPath}
							onChange={(e) => onNewProjectPathChange(e.target.value)}
							disabled={creatingProject}
							style={{ width: "260px" }}
						/>
						<button
							type="submit"
							className="mxd-btn mxd-btn-primary"
							style={{ fontSize: "12px", padding: "4px 10px" }}
							disabled={
								creatingProject || !newProjectPath.trim().startsWith("/")
							}
						>
							{creatingProject ? (
								<>
									<span className="mxd-spinner" /> {t("project.adding")}
								</>
							) : (
								t("project.add")
							)}
						</button>
						<button
							type="button"
							className="mxd-btn-icon"
							title={t("project.cancel")}
							onClick={onCancelAddProject}
							disabled={creatingProject}
						>
							<IconClose size={11} />
						</button>
					</form>
				) : (
					<>
						{projects.length > 0 && (
							<select
								className="mxd-select mxd-project-select"
								value={projectId}
								onChange={(e) => onProjectChange(e.target.value)}
							>
								{projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.pathExists === false ? "⚠ " : ""}
										{p.name}
									</option>
								))}
							</select>
						)}
						{projects.length === 0 && (
							<span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
								{t("project.noProjects")}
							</span>
						)}
						{scopes && scopes.length > 0 && (
							<select
								className="mxd-select mxd-scope-select"
								value={selectedScope ?? ""}
								onChange={(e) => onScopeChange?.(e.target.value)}
							>
								{scopes.map((s) => (
									<option key={s.name} value={s.name}>
										{s.name}
									</option>
								))}
							</select>
						)}
						<button
							type="button"
							className="mxd-btn-icon"
							title={t("project.addProject")}
							onClick={onShowAddProject}
						>
							<IconPlus size={14} />
						</button>
					</>
				)}
				{projectId && (
					<button
						type="button"
						className={`mxd-btn-icon mxd-settings-toggle-btn${showSettings ? " active" : ""}`}
						title={t("project.settings")}
						aria-label={t("project.settings")}
						onClick={onToggleSettings}
					>
						<IconGear size={14} />
					</button>
				)}
				{onLogout && (
					<button
						type="button"
						className="mxd-btn-icon mxd-logout-btn"
						title={t("header.logout")}
						aria-label={t("header.logout")}
						onClick={onLogout}
					>
						<IconLogout size={13} />
					</button>
				)}
			</div>
		</header>
	);
});
