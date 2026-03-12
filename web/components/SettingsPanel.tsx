import { useLocale } from "../i18n.ts";
import { IconClose, IconRefresh } from "./icons.tsx";

export function SettingsPanel({
	config,
	updateConfig,
	onClose,
	onRestart,
}: {
	config: Record<string, unknown>;
	updateConfig: (patch: Record<string, unknown>) => void;
	onClose: () => void;
	onRestart: () => void;
}) {
	const { t } = useLocale();
	return (
		<div className="og-settings-panel">
			<div className="og-settings-header">
				<span className="og-settings-title">{t("settings.title")}</span>
				<button type="button" className="og-btn-icon" onClick={onClose}>
					<IconClose size={11} />
				</button>
			</div>
			<label className="og-settings-field">
				<span className="og-settings-label">{t("settings.modelOverride")}</span>
				<input
					type="text"
					className="og-settings-input"
					placeholder={t("settings.modelOverridePlaceholder")}
					value={(config.model as string) || ""}
					onChange={(e) => updateConfig({ model: e.target.value || null })}
				/>
			</label>
			<label className="og-settings-field">
				<span className="og-settings-label">{t("settings.childModel")}</span>
				<input
					type="text"
					className="og-settings-input"
					placeholder={t("settings.childModelPlaceholder")}
					value={(config.childModel as string) || ""}
					onChange={(e) => updateConfig({ childModel: e.target.value || null })}
				/>
			</label>
			<label className="og-settings-field">
				<span className="og-settings-label">{t("settings.budget")}</span>
				<input
					type="number"
					className="og-settings-input"
					placeholder={t("settings.unlimited")}
					min="0"
					step="0.01"
					value={config.budgetUsd != null ? String(config.budgetUsd) : ""}
					onChange={(e) =>
						updateConfig({
							budgetUsd: e.target.value ? Number(e.target.value) : null,
						})
					}
				/>
			</label>
			<label className="og-settings-field">
				<span className="og-settings-label">
					{t("settings.clarifyTimeout")}
				</span>
				<input
					type="number"
					className="og-settings-input"
					placeholder={t("settings.noTimeout")}
					min="0"
					step="1000"
					value={
						config.clarifyTimeoutMs != null
							? String(config.clarifyTimeoutMs)
							: ""
					}
					onChange={(e) =>
						updateConfig({
							clarifyTimeoutMs: e.target.value ? Number(e.target.value) : null,
						})
					}
				/>
			</label>
			<label className="og-settings-field">
				<span className="og-settings-label">{t("settings.maxDepth")}</span>
				<input
					type="number"
					className="og-settings-input"
					placeholder={t("settings.maxDepthDefault")}
					min="1"
					max="10"
					step="1"
					value={config.maxDepth != null ? String(config.maxDepth) : ""}
					onChange={(e) =>
						updateConfig({
							maxDepth: e.target.value ? Number(e.target.value) : null,
						})
					}
				/>
			</label>
			<div className="og-settings-field">
				<span className="og-settings-label">
					{t("settings.restartDaemonHint")}
				</span>
				<button
					type="button"
					className="og-btn og-btn-warning og-btn-sm"
					onClick={onRestart}
				>
					<IconRefresh size={12} /> {t("settings.restartDaemon")}
				</button>
			</div>
		</div>
	);
}
