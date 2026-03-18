import type React from "react";
import { useEffect, useState } from "react";
import type { Project } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import {
	IconClose,
	IconGear,
	IconHexagon,
	IconLogout,
	IconPlus,
	IconTrash,
} from "./icons.tsx";

export function AppHeader({
	connected,
	projects,
	projectId,
	showAddProject,
	newProjectPath,
	creatingProject,
	showSettings,
	theme,
	onProjectChange,
	onDeleteProject,
	onShowAddProject,
	onAddProject,
	onNewProjectPathChange,
	onCancelAddProject,
	onToggleSettings,
	onThemeChange,
	onLogout,
	onToggleSidebar,
}: {
	connected: boolean;
	projects: Project[];
	projectId: string;
	showAddProject: boolean;
	newProjectPath: string;
	creatingProject: boolean;
	showSettings: boolean;
	theme: string;
	onProjectChange: (id: string) => void;
	onDeleteProject: () => void;
	onShowAddProject: () => void;
	onAddProject: (e: React.FormEvent) => void;
	onNewProjectPathChange: (path: string) => void;
	onCancelAddProject: () => void;
	onToggleSettings: () => void;
	onThemeChange: (theme: string) => void;
	onLogout?: () => void;
	onToggleSidebar?: () => void;
}) {
	const { locale, setLocale, t } = useLocale();
	const [versionInfo, setVersionInfo] = useState<string>("");

	useEffect(() => {
		fetch("/version")
			.then((r) => r.json())
			.then((data: { version?: string; gitHash?: string }) => {
				const hash =
					data.gitHash && data.gitHash !== "unknown"
						? ` (${data.gitHash})`
						: "";
				setVersionInfo(`v${data.version ?? "?"}${hash}`);
			})
			.catch(() => {});
	}, []);

	return (
		<header className="og-header">
			<div className="og-header-brand">
				{onToggleSidebar && (
					<button
						type="button"
						className="og-hamburger-btn"
						onClick={onToggleSidebar}
						aria-label="Toggle sidebar"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							aria-hidden="true"
						>
							<rect
								x="1"
								y="3"
								width="14"
								height="1.5"
								rx="0.75"
								fill="currentColor"
							/>
							<rect
								x="1"
								y="7.25"
								width="14"
								height="1.5"
								rx="0.75"
								fill="currentColor"
							/>
							<rect
								x="1"
								y="11.5"
								width="14"
								height="1.5"
								rx="0.75"
								fill="currentColor"
							/>
						</svg>
					</button>
				)}
				<div className="og-logo">
					<IconHexagon size={14} />
				</div>
				<span className="og-header-title">{t("header.title")}</span>
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
				<div className={`og-connection-badge${connected ? " connected" : ""}`}>
					<span className="og-connection-dot" />
					{connected ? t("header.connected") : t("header.disconnected")}
				</div>
			</div>

			<div className="og-header-right">
				{showAddProject ? (
					<form
						onSubmit={onAddProject}
						style={{ display: "flex", alignItems: "center", gap: "6px" }}
					>
						<input
							className="og-continue-input"
							type="text"
							placeholder={t("project.pathPlaceholder")}
							value={newProjectPath}
							onChange={(e) => onNewProjectPathChange(e.target.value)}
							disabled={creatingProject}
							style={{ width: "220px" }}
						/>
						<button
							type="submit"
							className="og-btn og-btn-primary"
							style={{ fontSize: "12px", padding: "4px 10px" }}
							disabled={creatingProject}
						>
							{creatingProject ? (
								<>
									<span className="og-spinner" /> {t("project.adding")}
								</>
							) : (
								t("project.add")
							)}
						</button>
						<button
							type="button"
							className="og-btn-icon"
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
								className="og-select"
								value={projectId}
								onChange={(e) => onProjectChange(e.target.value)}
							>
								{projects.map((p) => (
									<option key={p.id} value={p.id}>
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
						{projectId && (
							<button
								type="button"
								className="og-btn-icon"
								title={t("project.remove")}
								onClick={onDeleteProject}
							>
								<IconTrash size={13} />
							</button>
						)}
						<button
							type="button"
							className="og-btn-icon"
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
						className={`og-btn-icon${showSettings ? " active" : ""}`}
						title={t("project.settings")}
						aria-label={t("project.settings")}
						onClick={onToggleSettings}
					>
						<IconGear size={14} />
					</button>
				)}
				<select
					className="og-select"
					value={locale}
					onChange={(e) => setLocale(e.target.value as "en" | "zh")}
					title={t("lang.selector")}
					aria-label={t("lang.selector")}
				>
					<option value="en">{t("lang.en")}</option>
					<option value="zh">{t("lang.zh")}</option>
				</select>
				<select
					className="og-select"
					value={theme}
					onChange={(e) => onThemeChange(e.target.value)}
					title={t("theme.selector")}
					aria-label={t("theme.selector")}
				>
					<option value="dark">{t("theme.dark")}</option>
					<option value="light">{t("theme.light")}</option>
					<option value="cute-light">{t("theme.cuteLight")}</option>
					<option value="cute-dark">{t("theme.cuteDark")}</option>
				</select>
				{onLogout && (
					<button
						type="button"
						className="og-btn-icon"
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
}
