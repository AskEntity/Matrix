import { useState } from "react";
import type { ThreeLayerConfig } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconClose, IconPlus, IconRefresh, IconTrash } from "./icons.tsx";

// ---- Helpers ----

type Layer = "global" | "repo" | "local";

function sourceLabel(layers: ThreeLayerConfig, field: string): Layer | null {
	if (layers.local[field] !== undefined) return "local";
	if (layers.repo[field] !== undefined) return "repo";
	if (layers.global[field] !== undefined) return "global";
	return null;
}

function layerValue(
	layers: ThreeLayerConfig,
	layer: Layer,
	field: string,
): unknown {
	return layers[layer][field];
}

// ---- ThreeLayerField ----

function ThreeLayerStringField({
	label,
	field,
	placeholder,
	layers,
	updateGlobal,
	updateRepo,
	updateLocal,
}: {
	label: string;
	field: string;
	placeholder?: string;
	layers: ThreeLayerConfig;
	updateGlobal: (patch: Record<string, unknown>) => void;
	updateRepo: (patch: Record<string, unknown>) => void;
	updateLocal: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const src = sourceLabel(layers, field);
	const effective = layers.resolved[field] as string | undefined;

	return (
		<div className="og-tlfield">
			<div className="og-tlfield-header">
				<span className="og-settings-label">{label}</span>
				{src && (
					<span className={`og-tlfield-source og-tlfield-source-${src}`}>
						{t(
							`settings.from${src.charAt(0).toUpperCase()}${src.slice(1)}` as "settings.fromGlobal",
						)}
					</span>
				)}
			</div>
			{effective && <div className="og-tlfield-effective">{effective}</div>}
			<div className="og-tl-layers">
				<ThreeLayerInput
					layerName="global"
					value={(layerValue(layers, "global", field) as string) ?? ""}
					placeholder={placeholder}
					onChange={(v) => updateGlobal({ [field]: v || null })}
				/>
				<ThreeLayerInput
					layerName="repo"
					value={(layerValue(layers, "repo", field) as string) ?? ""}
					placeholder={placeholder}
					onChange={(v) => updateRepo({ [field]: v || null })}
				/>
				<ThreeLayerInput
					layerName="local"
					value={(layerValue(layers, "local", field) as string) ?? ""}
					placeholder={placeholder}
					onChange={(v) => updateLocal({ [field]: v || null })}
				/>
			</div>
		</div>
	);
}

function ThreeLayerNumberField({
	label,
	field,
	placeholder,
	min,
	step,
	layers,
	updateGlobal,
	updateRepo,
	updateLocal,
}: {
	label: string;
	field: string;
	placeholder?: string;
	min?: number;
	step?: number;
	layers: ThreeLayerConfig;
	updateGlobal: (patch: Record<string, unknown>) => void;
	updateRepo: (patch: Record<string, unknown>) => void;
	updateLocal: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const src = sourceLabel(layers, field);
	const effective = layers.resolved[field] as number | undefined;

	return (
		<div className="og-tlfield">
			<div className="og-tlfield-header">
				<span className="og-settings-label">{label}</span>
				{src && (
					<span className={`og-tlfield-source og-tlfield-source-${src}`}>
						{t(
							`settings.from${src.charAt(0).toUpperCase()}${src.slice(1)}` as "settings.fromGlobal",
						)}
					</span>
				)}
			</div>
			{effective !== undefined && (
				<div className="og-tlfield-effective">{effective}</div>
			)}
			<div className="og-tl-layers">
				<ThreeLayerNumberInput
					layerName="global"
					value={layerValue(layers, "global", field) as number | undefined}
					placeholder={placeholder}
					min={min}
					step={step}
					onChange={(v) => updateGlobal({ [field]: v ?? null })}
				/>
				<ThreeLayerNumberInput
					layerName="repo"
					value={layerValue(layers, "repo", field) as number | undefined}
					placeholder={placeholder}
					min={min}
					step={step}
					onChange={(v) => updateRepo({ [field]: v ?? null })}
				/>
				<ThreeLayerNumberInput
					layerName="local"
					value={layerValue(layers, "local", field) as number | undefined}
					placeholder={placeholder}
					min={min}
					step={step}
					onChange={(v) => updateLocal({ [field]: v ?? null })}
				/>
			</div>
		</div>
	);
}

function ThreeLayerInput({
	layerName,
	value,
	placeholder,
	onChange,
}: {
	layerName: Layer;
	value: string;
	placeholder?: string;
	onChange: (v: string) => void;
}) {
	const { t } = useLocale();
	const label = t(
		`settings.layer${layerName.charAt(0).toUpperCase()}${layerName.slice(1)}` as "settings.layerGlobal",
	);
	return (
		<div className={`og-tl-layer og-tl-layer-${layerName}`}>
			<span className="og-tl-layer-label">{label}</span>
			<input
				type="text"
				className="og-settings-input"
				placeholder={placeholder ?? t("settings.inherit")}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

function ThreeLayerNumberInput({
	layerName,
	value,
	placeholder,
	min,
	step,
	onChange,
}: {
	layerName: Layer;
	value: number | undefined;
	placeholder?: string;
	min?: number;
	step?: number;
	onChange: (v: number | null) => void;
}) {
	const { t } = useLocale();
	const label = t(
		`settings.layer${layerName.charAt(0).toUpperCase()}${layerName.slice(1)}` as "settings.layerGlobal",
	);
	return (
		<div className={`og-tl-layer og-tl-layer-${layerName}`}>
			<span className="og-tl-layer-label">{label}</span>
			<input
				type="number"
				className="og-settings-input"
				placeholder={placeholder ?? t("settings.inherit")}
				min={min}
				step={step}
				value={value !== undefined ? String(value) : ""}
				onChange={(e) =>
					onChange(e.target.value ? Number(e.target.value) : null)
				}
			/>
		</div>
	);
}

// ---- Auth Groups ----

interface AuthGroup {
	provider: "anthropic" | "openai";
	anthropicApiKey?: string;
	claudeOauthToken?: string;
	openaiApiKey?: string;
	openaiBaseUrl?: string;
}

function AuthGroupEditor({
	name,
	group,
	onSave,
	onDelete,
	onCancel,
}: {
	name: string;
	group: AuthGroup;
	onSave: (name: string, group: AuthGroup) => void;
	onDelete?: () => void;
	onCancel: () => void;
}) {
	const { t } = useLocale();
	const [editName, setEditName] = useState(name);
	const [provider, setProvider] = useState<"anthropic" | "openai">(
		group.provider,
	);
	const [anthropicApiKey, setAnthropicApiKey] = useState(
		group.anthropicApiKey ?? "",
	);
	const [claudeOauthToken, setClaudeOauthToken] = useState(
		group.claudeOauthToken ?? "",
	);
	const [openaiApiKey, setOpenaiApiKey] = useState(group.openaiApiKey ?? "");
	const [openaiBaseUrl, setOpenaiBaseUrl] = useState(group.openaiBaseUrl ?? "");

	const handleSave = () => {
		const g: AuthGroup = { provider };
		if (provider === "anthropic") {
			if (anthropicApiKey) g.anthropicApiKey = anthropicApiKey;
			if (claudeOauthToken) g.claudeOauthToken = claudeOauthToken;
		} else {
			if (openaiApiKey) g.openaiApiKey = openaiApiKey;
			if (openaiBaseUrl) g.openaiBaseUrl = openaiBaseUrl;
		}
		onSave(editName.trim() || name, g);
	};

	return (
		<div className="og-auth-editor">
			<label className="og-settings-field">
				<span className="og-settings-label">{t("settings.authName")}</span>
				<input
					type="text"
					className="og-settings-input"
					value={editName}
					onChange={(e) => setEditName(e.target.value)}
				/>
			</label>
			<label className="og-settings-field">
				<span className="og-settings-label">{t("settings.authProvider")}</span>
				<select
					className="og-select og-settings-input"
					value={provider}
					onChange={(e) =>
						setProvider(e.target.value as "anthropic" | "openai")
					}
				>
					<option value="anthropic">Anthropic</option>
					<option value="openai">OpenAI</option>
				</select>
			</label>
			{provider === "anthropic" ? (
				<>
					<label className="og-settings-field">
						<span className="og-settings-label">
							{t("settings.anthropicApiKey")}
						</span>
						<input
							type="password"
							className="og-settings-input"
							placeholder="sk-ant-..."
							value={anthropicApiKey}
							onChange={(e) => setAnthropicApiKey(e.target.value)}
						/>
					</label>
					<label className="og-settings-field">
						<span className="og-settings-label">
							{t("settings.claudeOauthToken")}
						</span>
						<input
							type="password"
							className="og-settings-input"
							placeholder={t("settings.optionalFallback")}
							value={claudeOauthToken}
							onChange={(e) => setClaudeOauthToken(e.target.value)}
						/>
					</label>
				</>
			) : (
				<>
					<label className="og-settings-field">
						<span className="og-settings-label">
							{t("settings.openaiApiKey")}
						</span>
						<input
							type="password"
							className="og-settings-input"
							placeholder="sk-..."
							value={openaiApiKey}
							onChange={(e) => setOpenaiApiKey(e.target.value)}
						/>
					</label>
					<label className="og-settings-field">
						<span className="og-settings-label">
							{t("settings.openaiBaseUrl")}
						</span>
						<input
							type="text"
							className="og-settings-input"
							placeholder="https://api.openai.com/v1"
							value={openaiBaseUrl}
							onChange={(e) => setOpenaiBaseUrl(e.target.value)}
						/>
					</label>
				</>
			)}
			<div className="og-auth-editor-actions">
				<button
					type="button"
					className="og-btn og-btn-sm og-btn-primary"
					onClick={handleSave}
				>
					{t("settings.save")}
				</button>
				<button type="button" className="og-btn og-btn-sm" onClick={onCancel}>
					{t("settings.cancel")}
				</button>
				{onDelete && (
					<button
						type="button"
						className="og-btn og-btn-sm og-btn-danger"
						onClick={onDelete}
					>
						<IconTrash size={11} />
					</button>
				)}
			</div>
		</div>
	);
}

function AuthGroupsSection({
	layers,
	updateGlobal,
}: {
	layers: ThreeLayerConfig;
	updateGlobal: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const [editingGroup, setEditingGroup] = useState<string | null>(null);
	const [addingNew, setAddingNew] = useState(false);

	const authGroups = (layers.global.authGroups ?? {}) as Record<
		string,
		AuthGroup
	>;

	const saveGroup = (oldName: string, newName: string, group: AuthGroup) => {
		const updated = { ...authGroups };
		if (oldName !== newName) delete updated[oldName];
		updated[newName] = group;
		updateGlobal({ authGroups: updated });
		setEditingGroup(null);
		setAddingNew(false);
	};

	const deleteGroup = (name: string) => {
		const updated = { ...authGroups };
		delete updated[name];
		updateGlobal({ authGroups: updated });
		setEditingGroup(null);
	};

	return (
		<div className="og-settings-section">
			<div className="og-settings-section-title og-settings-section-global">
				{t("settings.authGroups")}
			</div>
			{Object.entries(authGroups).map(([name, group]) => (
				<div key={name} className="og-auth-group-row">
					{editingGroup === name ? (
						<AuthGroupEditor
							name={name}
							group={group}
							onSave={(newName, g) => saveGroup(name, newName, g)}
							onDelete={() => deleteGroup(name)}
							onCancel={() => setEditingGroup(null)}
						/>
					) : (
						<button
							type="button"
							className="og-auth-group-item"
							onClick={() => setEditingGroup(name)}
						>
							<span className="og-auth-group-name">{name}</span>
							<span className="og-auth-group-provider">{group.provider}</span>
						</button>
					)}
				</div>
			))}
			{addingNew ? (
				<AuthGroupEditor
					name=""
					group={{ provider: "anthropic" }}
					onSave={(newName, g) => saveGroup("", newName, g)}
					onCancel={() => setAddingNew(false)}
				/>
			) : (
				<button
					type="button"
					className="og-btn og-btn-sm"
					onClick={() => {
						setAddingNew(true);
						setEditingGroup(null);
					}}
				>
					<IconPlus size={11} /> {t("settings.addAuthGroup")}
				</button>
			)}
		</div>
	);
}

// ---- Main SettingsPanel ----

export function SettingsPanel({
	layers,
	loading,
	updateGlobal,
	updateRepo,
	updateLocal,
	onClose,
	onRestart,
}: {
	projectId: string;
	layers: ThreeLayerConfig;
	loading: boolean;
	updateGlobal: (patch: Record<string, unknown>) => void;
	updateRepo: (patch: Record<string, unknown>) => void;
	updateLocal: (patch: Record<string, unknown>) => void;
	onClose: () => void;
	onRestart: () => void;
}) {
	const { t } = useLocale();

	return (
		<div className="og-settings-panel og-settings-panel-wide">
			<div className="og-settings-header">
				<span className="og-settings-title">{t("settings.title")}</span>
				<button type="button" className="og-btn-icon" onClick={onClose}>
					<IconClose size={11} />
				</button>
			</div>

			{loading && (
				<div className="og-settings-loading">{t("settings.loading")}</div>
			)}

			{/* Layer legend */}
			<div className="og-tl-legend">
				<span className="og-tl-layer-label og-tl-layer-label-global">
					{t("settings.layerGlobal")}
				</span>
				<span className="og-tl-layer-label og-tl-layer-label-repo">
					{t("settings.layerRepo")}
				</span>
				<span className="og-tl-layer-label og-tl-layer-label-local">
					{t("settings.layerLocal")}
				</span>
			</div>

			{/* Model settings */}
			<div className="og-settings-section">
				<div className="og-settings-section-title">
					{t("settings.sectionModels")}
				</div>
				<ThreeLayerStringField
					label={t("settings.modelOverride")}
					field="model"
					placeholder={t("settings.modelOverridePlaceholder")}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
				<ThreeLayerStringField
					label={t("settings.childModel")}
					field="childModel"
					placeholder={t("settings.childModelPlaceholder")}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
				<ThreeLayerStringField
					label={t("settings.defaultAuth")}
					field="defaultAuth"
					placeholder={t("settings.authGroupName")}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
				<ThreeLayerStringField
					label={t("settings.childAuth")}
					field="childAuth"
					placeholder={t("settings.authGroupName")}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
			</div>

			{/* Limits */}
			<div className="og-settings-section">
				<div className="og-settings-section-title">
					{t("settings.sectionLimits")}
				</div>
				<ThreeLayerNumberField
					label={t("settings.budget")}
					field="budgetUsd"
					placeholder={t("settings.unlimited")}
					min={0}
					step={0.01}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
				<ThreeLayerNumberField
					label={t("settings.clarifyTimeout")}
					field="clarifyTimeoutMs"
					placeholder={t("settings.noTimeout")}
					min={0}
					step={1000}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
				<ThreeLayerNumberField
					label={t("settings.maxDepth")}
					field="maxDepth"
					placeholder={t("settings.maxDepthDefault")}
					min={1}
					step={1}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
			</div>

			{/* Auth Groups */}
			<AuthGroupsSection layers={layers} updateGlobal={updateGlobal} />

			{/* Daemon */}
			<div className="og-settings-section">
				<div className="og-settings-section-title">
					{t("settings.sectionDaemon")}
				</div>
				<ThreeLayerNumberField
					label={t("settings.port")}
					field="port"
					placeholder="7433"
					min={1024}
					step={1}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
				<ThreeLayerNumberField
					label={t("settings.sessionKeep")}
					field="sessionKeep"
					placeholder="5"
					min={1}
					step={1}
					layers={layers}
					updateGlobal={updateGlobal}
					updateRepo={updateRepo}
					updateLocal={updateLocal}
				/>
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
		</div>
	);
}
