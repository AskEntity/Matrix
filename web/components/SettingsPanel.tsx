import { useEffect, useState } from "react";
import type { ThreeLayerConfig } from "../hooks.ts";
import { useLocale } from "../i18n.ts";
import { IconClose, IconPlus, IconRefresh, IconTrash } from "./icons.tsx";

// ---- Types ----

type ActiveTab = "global" | "project" | "local";

interface AuthGroup {
	provider: "anthropic" | "openai";
	anthropicApiKey?: string;
	claudeOauthToken?: string;
	openaiApiKey?: string;
	openaiBaseUrl?: string;
}

interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

// ---- Helpers ----

/** Compute the inherited value for a field when reading from a specific layer perspective.
 *  "inherited" means: what would the effective value be if this layer did NOT set it?
 *  For global: nothing to inherit from (there's no lower layer).
 *  For repo: inherit from global.
 *  For local: inherit from repo or global.
 */
function inheritedValue(
	layers: ThreeLayerConfig,
	tab: ActiveTab,
	field: string,
): string | undefined {
	if (tab === "global") return undefined;
	if (tab === "project") {
		const v = layers.global[field];
		return v !== undefined ? String(v) : undefined;
	}
	// local: prefer repo, then global
	const rv = layers.repo[field];
	if (rv !== undefined) return String(rv);
	const gv = layers.global[field];
	if (gv !== undefined) return String(gv);
	return undefined;
}

/** Check if two draft objects differ from the saved layer config */
function isDirty(
	draft: Record<string, unknown>,
	saved: Record<string, unknown>,
): boolean {
	// Check all keys in draft
	for (const key of Object.keys(draft)) {
		const dv = draft[key];
		const sv = saved[key];
		if (JSON.stringify(dv) !== JSON.stringify(sv)) return true;
	}
	// Check keys in saved that are missing from draft (treat as undefined)
	for (const key of Object.keys(saved)) {
		if (!(key in draft)) {
			if (saved[key] !== undefined) return true;
		}
	}
	return false;
}

// ---- Simple field components (single-layer, controlled) ----

function SettingStringField({
	label,
	field,
	placeholder,
	type,
	tab,
	layers,
	draft,
	onDraftChange,
}: {
	label: string;
	field: string;
	placeholder?: string;
	type?: string;
	tab: ActiveTab;
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const inherited = inheritedValue(layers, tab, field);
	const value = (draft[field] as string | undefined) ?? "";

	return (
		<div className="og-settings-field">
			<span className="og-settings-label">{label}</span>
			<input
				type={type ?? "text"}
				className="og-settings-input"
				placeholder={inherited ?? placeholder ?? t("settings.inherit")}
				value={value}
				onChange={(e) => onDraftChange({ [field]: e.target.value })}
			/>
		</div>
	);
}

function SettingNumberField({
	label,
	field,
	placeholder,
	min,
	step,
	tab,
	layers,
	draft,
	onDraftChange,
}: {
	label: string;
	field: string;
	placeholder?: string;
	min?: number;
	step?: number;
	tab: ActiveTab;
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const inherited = inheritedValue(layers, tab, field);
	const value = draft[field] !== undefined ? String(draft[field]) : "";

	return (
		<div className="og-settings-field">
			<span className="og-settings-label">{label}</span>
			<input
				type="number"
				className="og-settings-input"
				placeholder={inherited ?? placeholder ?? t("settings.inherit")}
				min={min}
				step={step}
				value={value}
				onChange={(e) =>
					onDraftChange({
						[field]: e.target.value ? Number(e.target.value) : undefined,
					})
				}
			/>
		</div>
	);
}

// ---- Auth Group Editor ----

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

// ---- Auth Groups Section ----

function AuthGroupsSection({
	draft,
	onDraftChange,
}: {
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const [editingGroup, setEditingGroup] = useState<string | null>(null);
	const [addingNew, setAddingNew] = useState(false);

	const authGroups = (draft.authGroups ?? {}) as Record<string, AuthGroup>;

	const saveGroup = (oldName: string, newName: string, group: AuthGroup) => {
		const updated = { ...authGroups };
		if (oldName !== newName) delete updated[oldName];
		updated[newName] = group;
		onDraftChange({ authGroups: updated });
		setEditingGroup(null);
		setAddingNew(false);
	};

	const deleteGroup = (name: string) => {
		const updated = { ...authGroups };
		delete updated[name];
		onDraftChange({ authGroups: updated });
		setEditingGroup(null);
	};

	const maskedKey = (group: AuthGroup): string => {
		const key =
			group.anthropicApiKey || group.claudeOauthToken || group.openaiApiKey;
		if (!key) return "—";
		return `${key.slice(0, 6)}…${key.slice(-4)}`;
	};

	return (
		<div className="og-settings-auth-groups">
			<div className="og-settings-label og-settings-auth-groups-title">
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
							onClick={() => {
								setEditingGroup(name);
								setAddingNew(false);
							}}
						>
							<span className="og-auth-group-name">{name}</span>
							<span className="og-auth-group-provider">
								<span className="og-auth-group-badge">{group.provider}</span>
								<span className="og-auth-group-key">{maskedKey(group)}</span>
							</span>
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

// ---- MCP Servers Section ----

function McpServersSection({
	tab,
	layers,
	draft,
	onDraftChange,
}: {
	tab: ActiveTab;
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const [addingNew, setAddingNew] = useState(false);
	const [newName, setNewName] = useState("");
	const [newCommand, setNewCommand] = useState("");
	const [newArgs, setNewArgs] = useState("");

	const servers = (draft.mcpServers ?? {}) as Record<string, McpServerConfig>;
	// inherited from lower layers
	const inheritedServers: Record<string, McpServerConfig> = {};
	if (tab === "local") {
		const repoServers = (layers.repo.mcpServers ?? {}) as Record<
			string,
			McpServerConfig
		>;
		const globalServers = (layers.global.mcpServers ?? {}) as Record<
			string,
			McpServerConfig
		>;
		Object.assign(inheritedServers, globalServers, repoServers);
	} else if (tab === "project") {
		const globalServers = (layers.global.mcpServers ?? {}) as Record<
			string,
			McpServerConfig
		>;
		Object.assign(inheritedServers, globalServers);
	}

	const deleteServer = (name: string) => {
		const updated = { ...servers };
		delete updated[name];
		onDraftChange({
			mcpServers: Object.keys(updated).length > 0 ? updated : undefined,
		});
	};

	const addServer = () => {
		if (!newName.trim() || !newCommand.trim()) return;
		const args = newArgs.trim().split(/\s+/).filter(Boolean);
		const server: McpServerConfig = {
			command: newCommand.trim(),
			...(args.length > 0 ? { args } : {}),
		};
		onDraftChange({ mcpServers: { ...servers, [newName.trim()]: server } });
		setNewName("");
		setNewCommand("");
		setNewArgs("");
		setAddingNew(false);
	};

	return (
		<div className="og-settings-section">
			<div className="og-settings-section-title">
				{t("settings.mcpServers")}
			</div>

			{/* Inherited servers (read-only) */}
			{Object.entries(inheritedServers)
				.filter(([n]) => !(n in servers))
				.map(([name, srv]) => (
					<div key={name} className="og-mcp-server-row og-mcp-server-inherited">
						<span className="og-mcp-server-name">{name}</span>
						<span className="og-mcp-server-cmd">{srv.command}</span>
						<span className="og-mcp-server-inherited-badge">
							{t("settings.inherited")}
						</span>
					</div>
				))}

			{/* This layer's servers */}
			{Object.entries(servers).map(([name, srv]) => (
				<div key={name} className="og-mcp-server-row">
					<span className="og-mcp-server-name">{name}</span>
					<span className="og-mcp-server-cmd">{srv.command}</span>
					<button
						type="button"
						className="og-btn-icon og-mcp-server-delete"
						onClick={() => deleteServer(name)}
						title={t("settings.delete")}
					>
						<IconTrash size={10} />
					</button>
				</div>
			))}

			{addingNew ? (
				<div className="og-mcp-server-add-form">
					<input
						type="text"
						className="og-settings-input"
						placeholder={t("settings.mcpServerName")}
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
					/>
					<input
						type="text"
						className="og-settings-input"
						placeholder={t("settings.mcpServerCommand")}
						value={newCommand}
						onChange={(e) => setNewCommand(e.target.value)}
					/>
					<input
						type="text"
						className="og-settings-input"
						placeholder={t("settings.mcpServerArgs")}
						value={newArgs}
						onChange={(e) => setNewArgs(e.target.value)}
					/>
					<div className="og-auth-editor-actions">
						<button
							type="button"
							className="og-btn og-btn-sm og-btn-primary"
							onClick={addServer}
						>
							{t("settings.save")}
						</button>
						<button
							type="button"
							className="og-btn og-btn-sm"
							onClick={() => {
								setAddingNew(false);
								setNewName("");
								setNewCommand("");
								setNewArgs("");
							}}
						>
							{t("settings.cancel")}
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					className="og-btn og-btn-sm"
					onClick={() => setAddingNew(true)}
				>
					<IconPlus size={11} /> {t("settings.addMcpServer")}
				</button>
			)}
		</div>
	);
}

// ---- Tab-level Save/Revert bar ----

function TabActions({
	dirty,
	onSave,
	onRevert,
}: {
	dirty: boolean;
	onSave: () => void;
	onRevert: () => void;
}) {
	const { t } = useLocale();
	return (
		<div className="og-settings-tab-actions">
			<button
				type="button"
				className="og-btn og-btn-sm og-btn-primary"
				onClick={onSave}
				disabled={!dirty}
			>
				{t("settings.save")}
			</button>
			<button
				type="button"
				className="og-btn og-btn-sm og-btn-ghost"
				onClick={onRevert}
				disabled={!dirty}
			>
				{t("settings.revert")}
			</button>
		</div>
	);
}

// ---- Tab Content ----

function GlobalTab({
	layers,
	draft,
	onDraftChange,
	onSave,
	onRevert,
	dirty,
	onRestart,
}: {
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
	onSave: () => void;
	onRevert: () => void;
	dirty: boolean;
	onRestart: () => void;
}) {
	const { t } = useLocale();
	const tab: ActiveTab = "global";

	return (
		<div className="og-tab-content">
			<AuthGroupsSection draft={draft} onDraftChange={onDraftChange} />

			<div className="og-settings-section">
				<div className="og-settings-section-title">
					{t("settings.sectionModels")}
				</div>
				<SettingStringField
					label={t("settings.defaultAuth")}
					field="defaultAuth"
					placeholder={t("settings.authGroupName")}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
				<SettingStringField
					label={t("settings.modelOverride")}
					field="model"
					placeholder={t("settings.modelOverridePlaceholder")}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
			</div>

			<div className="og-settings-section">
				<div className="og-settings-section-title">
					{t("settings.sectionDaemon")}
				</div>
				<SettingNumberField
					label={t("settings.port")}
					field="port"
					placeholder="7433"
					min={1024}
					step={1}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
				<SettingNumberField
					label={t("settings.sessionKeep")}
					field="sessionKeep"
					placeholder="5"
					min={1}
					step={1}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
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

			<TabActions dirty={dirty} onSave={onSave} onRevert={onRevert} />
		</div>
	);
}

function ProjectTab({
	tab,
	layers,
	draft,
	onDraftChange,
	onSave,
	onRevert,
	dirty,
}: {
	tab: ActiveTab;
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
	onSave: () => void;
	onRevert: () => void;
	dirty: boolean;
}) {
	const { t } = useLocale();

	return (
		<div className="og-tab-content">
			<div className="og-settings-section">
				<div className="og-settings-section-title">
					{t("settings.sectionModels")}
				</div>
				<SettingStringField
					label={t("settings.modelOverride")}
					field="model"
					placeholder={t("settings.modelOverridePlaceholder")}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
				<SettingStringField
					label={t("settings.childAuth")}
					field="childAuth"
					placeholder={t("settings.authGroupName")}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
				<SettingStringField
					label={t("settings.childModel")}
					field="childModel"
					placeholder={t("settings.childModelPlaceholder")}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
			</div>

			<div className="og-settings-section">
				<div className="og-settings-section-title">
					{t("settings.sectionLimits")}
				</div>
				<SettingNumberField
					label={t("settings.budget")}
					field="budgetUsd"
					placeholder={t("settings.unlimited")}
					min={0}
					step={0.01}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
				<SettingNumberField
					label={t("settings.maxDepth")}
					field="maxDepth"
					placeholder={t("settings.maxDepthDefault")}
					min={1}
					step={1}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
				<SettingNumberField
					label={t("settings.clarifyTimeout")}
					field="clarifyTimeoutMs"
					placeholder={t("settings.noTimeout")}
					min={0}
					step={1000}
					tab={tab}
					layers={layers}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
			</div>

			<McpServersSection
				tab={tab}
				layers={layers}
				draft={draft}
				onDraftChange={onDraftChange}
			/>

			<TabActions dirty={dirty} onSave={onSave} onRevert={onRevert} />
		</div>
	);
}

// ---- Build diff patch: only send fields that changed ----

function buildPatch(
	draft: Record<string, unknown>,
	saved: Record<string, unknown>,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	// Fields in draft that differ from saved
	for (const key of Object.keys(draft)) {
		const dv = draft[key];
		const sv = saved[key];
		if (JSON.stringify(dv) !== JSON.stringify(sv)) {
			// Send undefined as null to explicitly clear the field
			patch[key] = dv === undefined ? null : dv;
		}
	}
	// Fields in saved but missing/removed from draft — send null to clear
	for (const key of Object.keys(saved)) {
		if (!(key in draft) && saved[key] !== undefined) {
			patch[key] = null;
		}
	}
	return patch;
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
	const [activeTab, setActiveTab] = useState<ActiveTab>("global");

	// Draft state per tab — initialized from layers, reset when layers changes
	const [draftGlobal, setDraftGlobal] = useState<Record<string, unknown>>(
		() => ({ ...layers.global }),
	);
	const [draftRepo, setDraftRepo] = useState<Record<string, unknown>>(() => ({
		...layers.repo,
	}));
	const [draftLocal, setDraftLocal] = useState<Record<string, unknown>>(() => ({
		...layers.local,
	}));

	// When layers changes after a save, reset drafts to the new saved values
	useEffect(() => {
		setDraftGlobal({ ...layers.global });
	}, [layers.global]);

	useEffect(() => {
		setDraftRepo({ ...layers.repo });
	}, [layers.repo]);

	useEffect(() => {
		setDraftLocal({ ...layers.local });
	}, [layers.local]);

	// Patch update handlers for each draft
	const updateDraftGlobal = (patch: Record<string, unknown>) => {
		setDraftGlobal((prev) => {
			const next = { ...prev };
			for (const [k, v] of Object.entries(patch)) {
				if (v === undefined || v === null || v === "") {
					delete next[k];
				} else {
					next[k] = v;
				}
			}
			return next;
		});
	};

	const updateDraftRepo = (patch: Record<string, unknown>) => {
		setDraftRepo((prev) => {
			const next = { ...prev };
			for (const [k, v] of Object.entries(patch)) {
				if (v === undefined || v === null || v === "") {
					delete next[k];
				} else {
					next[k] = v;
				}
			}
			return next;
		});
	};

	const updateDraftLocal = (patch: Record<string, unknown>) => {
		setDraftLocal((prev) => {
			const next = { ...prev };
			for (const [k, v] of Object.entries(patch)) {
				if (v === undefined || v === null || v === "") {
					delete next[k];
				} else {
					next[k] = v;
				}
			}
			return next;
		});
	};

	// Dirty flags
	const dirtyGlobal = isDirty(draftGlobal, layers.global);
	const dirtyRepo = isDirty(draftRepo, layers.repo);
	const dirtyLocal = isDirty(draftLocal, layers.local);

	// Save handlers — compute diff patch and send
	const saveGlobal = () => {
		const patch = buildPatch(draftGlobal, layers.global);
		if (Object.keys(patch).length > 0) updateGlobal(patch);
	};

	const saveRepo = () => {
		const patch = buildPatch(draftRepo, layers.repo);
		if (Object.keys(patch).length > 0) updateRepo(patch);
	};

	const saveLocal = () => {
		const patch = buildPatch(draftLocal, layers.local);
		if (Object.keys(patch).length > 0) updateLocal(patch);
	};

	// Revert handlers — reset draft to current saved state
	const revertGlobal = () => setDraftGlobal({ ...layers.global });
	const revertRepo = () => setDraftRepo({ ...layers.repo });
	const revertLocal = () => setDraftLocal({ ...layers.local });

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

			{/* Tab buttons */}
			<div className="og-settings-tabs">
				<button
					type="button"
					className={`og-settings-tab og-settings-tab-global${activeTab === "global" ? " og-settings-tab-active og-settings-tab-active-global" : ""}`}
					onClick={() => setActiveTab("global")}
				>
					{t("settings.tabGlobal")}
					{dirtyGlobal && <span className="og-settings-dirty">*</span>}
				</button>
				<button
					type="button"
					className={`og-settings-tab og-settings-tab-project${activeTab === "project" ? " og-settings-tab-active og-settings-tab-active-project" : ""}`}
					onClick={() => setActiveTab("project")}
				>
					{t("settings.tabProject")}
					{dirtyRepo && <span className="og-settings-dirty">*</span>}
				</button>
				<button
					type="button"
					className={`og-settings-tab og-settings-tab-local${activeTab === "local" ? " og-settings-tab-active og-settings-tab-active-local" : ""}`}
					onClick={() => setActiveTab("local")}
				>
					{t("settings.tabLocal")}
					{dirtyLocal && <span className="og-settings-dirty">*</span>}
				</button>
			</div>

			{/* Tab content */}
			{activeTab === "global" && (
				<GlobalTab
					layers={layers}
					draft={draftGlobal}
					onDraftChange={updateDraftGlobal}
					onSave={saveGlobal}
					onRevert={revertGlobal}
					dirty={dirtyGlobal}
					onRestart={onRestart}
				/>
			)}
			{activeTab === "project" && (
				<ProjectTab
					tab="project"
					layers={layers}
					draft={draftRepo}
					onDraftChange={updateDraftRepo}
					onSave={saveRepo}
					onRevert={revertRepo}
					dirty={dirtyRepo}
				/>
			)}
			{activeTab === "local" && (
				<ProjectTab
					tab="local"
					layers={layers}
					draft={draftLocal}
					onDraftChange={updateDraftLocal}
					onSave={saveLocal}
					onRevert={revertLocal}
					dirty={dirtyLocal}
				/>
			)}
		</div>
	);
}
