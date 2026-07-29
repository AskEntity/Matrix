import { useAuthFetch } from "@mxd/auth-context";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "../i18n.ts";
import { IconClose, IconPlus, IconRefresh, IconTrash } from "../icons.tsx";
import type { ThreeLayerConfig } from "./types.ts";

// ---- Types ----

type ActiveTab = "global" | "project" | "local";

interface AuthGroup {
	provider: "anthropic" | "openai";
	apiKey?: string;
	oauthToken?: string;
	accessToken?: string;
	refreshToken?: string;
	accountId?: string;
	baseUrl?: string;
	systemPreamble?: string;
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
export function isDirty(
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
		<div className="mxd-settings-field">
			<span className="mxd-settings-label">{label}</span>
			<input
				type="number"
				className="mxd-settings-input"
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

// Exported for web/SettingsPanel-inherit.test.tsx — see ModelsAuthSection.
export function SettingBoolField({
	label,
	field,
	tab,
	layers,
	draft,
	onDraftChange,
}: {
	label: string;
	field: string;
	tab: ActiveTab;
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const inherited = inheritedValue(layers, tab, field);
	const value = draft[field] as boolean | undefined;
	const isGlobal = tab === "global";
	const inheriting = !isGlobal && isInheriting(draft, field);

	// ⚠️ This field used to carry the comment "Three states: undefined
	// (inherit), true, false / indeterminate = inherit" while `indeterminate` was
	// set NOWHERE in the file, and its onChange was
	// `{ [field]: e.target.checked }` — which ALWAYS writes a boolean. So the
	// third state could be displayed (a small "(inherited)") and never returned
	// to: one click and the field was explicitly set forever. The same one-way
	// door as ModelsAuthSection, 40 lines apart, and the comment made the panel
	// look like it already had the mechanism. A 3-state value does not fit a
	// 2-state checkbox; the inherit state needs its own control.
	return (
		<div className="mxd-settings-field">
			<span className="mxd-settings-label">{label}</span>
			{!inheriting && (
				<label className="mxd-settings-toggle">
					<input
						type="checkbox"
						checked={value ?? false}
						onChange={(e) => onDraftChange({ [field]: e.target.checked })}
					/>
				</label>
			)}
			{!isGlobal && (
				<InheritToggle
					field={field}
					inherited={inherited}
					// A string would land in a boolean field — see InheritToggle.
					valueOnUntick={inherited === "true"}
					draft={draft}
					onDraftChange={onDraftChange}
				/>
			)}
		</div>
	);
}

// ---- Models & Auth Section (shared across all tabs) ----

/**
 * "Inherit" is the ABSENCE of the key in this layer's file — that is the config
 * model's own representation (each layer's type is a `Partial` of the fields that
 * layer may carry: `LocalConfig`, `RepoConfig`), and `buildPatch` already turns
 * an `undefined` draft value into the `null` that deletes the key.
 *
 * ⚠️ Which is why the checkbox is not decoration. Without it, `undefined`
 * (inherit) and `""` (explicit empty) render as the SAME empty text box, and
 * worse, typing-then-deleting leaves `""` in the draft with no gesture anywhere
 * that returns to `undefined` — so the panel could only ever move a project
 * INTO an explicit empty override, never back out. A project-layer `""`
 * overrides a real global value (`resolveConfig` overlays on
 * `value !== undefined`), and since no fallback substitutes a model any more,
 * that empty string now reaches the API.
 */
function isInheriting(draft: Record<string, unknown>, field: string): boolean {
	return draft[field] === undefined;
}

/**
 * Checkbox + a rendering of what is being inherited. Never shown on global.
 *
 * `valueOnUntick` is what unticking writes, and it is the CALLER's job because
 * only the call site knows the field's type: `inheritedValue()` returns a
 * display STRING, so a boolean field seeded from it would be handed `"true"`.
 * A 3-state value cannot live on a 2-state checkbox, which is the whole reason
 * this control is separate from the one holding the value.
 */
function InheritToggle({
	field,
	inherited,
	valueOnUntick,
	draft,
	onDraftChange,
}: {
	field: string;
	inherited: string | undefined;
	valueOnUntick: unknown;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const inheriting = isInheriting(draft, field);
	// Showing WHAT is inherited is most of the feature: "inheriting" alone
	// trades an invisible state for a better-labelled invisible state, and the
	// question a user has is "what will this project actually use".
	const shown =
		inherited === undefined || inherited === ""
			? t("settings.inheritNotSet")
			: inherited;

	return (
		<label className="mxd-settings-inherit-toggle">
			<input
				type="checkbox"
				checked={inheriting}
				onChange={(e) =>
					onDraftChange({
						// Ticking clears the key. Unticking seeds the value currently in
						// effect, so the user edits from what they have rather than from
						// an empty box — and the UI never authors an empty string.
						[field]: e.target.checked ? undefined : valueOnUntick,
					})
				}
			/>
			<span className="mxd-settings-inherit-label">
				{t("settings.inheritLabel")}
			</span>
			{inheriting && (
				<span className="mxd-settings-inherited-hint">
					{t("settings.inheritingValue", { value: shown })}
				</span>
			)}
		</label>
	);
}

// Exported for the standalone render in web/SettingsPanel-inherit.test.tsx —
// same reason CacheTtlSection is: mounting the whole panel drags in fetches and
// a dozen unrelated sections.
export function ModelsAuthSection({
	layer,
	layers,
	authGroupNames,
	draft,
	onDraftChange,
}: {
	layer: "global" | "project" | "local";
	layers: ThreeLayerConfig;
	authGroupNames: string[];
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();

	// ⚠️ The PROJECT (repo) tab does not render these fields at all, and the axis
	// is TRUST rather than scoping (user, 2026-07-29): the repo layer is
	// `<projectPath>/.mxd/config.json`, which is git-tracked and arrives with a
	// clone, so a cloned repo must not be able to choose the model or the auth
	// group an agent runs with. The local layer is under `~/.mxd/` and never
	// enters a repo. So the legal field sets of the two project layers genuinely
	// differ — this is not `GLOBAL_ONLY_FIELDS`, which is a different axis. It is
	// the repo layer's TYPE that says so now (`RepoConfig` has neither field), so
	// the daemon refuses both of them and a cloned config carrying one is stripped
	// when it is read. Offering a control that lands on that refusal would be a
	// remedy that cannot work.
	if (layer === "project") return null;

	const isGlobal = layer === "global";

	const inheritedAuth = inheritedValue(layers, layer, "defaultAuth");
	const inheritedModel = inheritedValue(layers, layer, "model");
	const authInheriting = !isGlobal && isInheriting(draft, "defaultAuth");
	const modelInheriting = !isGlobal && isInheriting(draft, "model");

	// ⚠️ The `?? ""` below is safe ONLY because `modelInheriting` above already
	// captured the distinction from the raw draft. Reading `?? ""` first and
	// deriving state from it afterwards is the collapse this section is about:
	// past that point `undefined` (inherit) and `""` (an explicit empty override)
	// are one value, and the inherit state can be neither rendered nor exited.
	const defaultAuth = (draft.defaultAuth as string | undefined) ?? "";
	const model = (draft.model as string | undefined) ?? "";
	// Root Auth options. On a project tab "" is NOT offered: it used to be
	// labelled "— Inherit —" there, which is the overload being removed, and as an
	// explicit project override it would mean "this project has no auth group",
	// which only breaks the project's agent. Inherit is the tickbox; global keeps
	// its "— None —" because global genuinely can have no auth configured yet.
	const rootAuthOptions: { value: string; label: string }[] = isGlobal
		? [{ value: "", label: t("settings.authGroupNone") }]
		: [];
	for (const name of authGroupNames) {
		rootAuthOptions.push({ value: name, label: name });
	}

	return (
		<div className="mxd-settings-section">
			<div className="mxd-settings-section-title">
				{t("settings.sectionModels")}
			</div>

			{/* Root Auth. Symmetric with Model: inheriting hides the select.
			    The old select offered every group name PLUS an option labelled
			    "inherit" whose value was "", and the daemon's guard 400'd any
			    defaultAuth string — so EVERY Root Auth change on a project tab
			    failed, the inherit one included. `defaultAuth` is now part of the
			    LOCAL layer's field set (a group name is not a credential, and the
			    name must already exist in the user's own global config), while
			    `authGroups` is in no project layer's set, and inherit is the absence
			    of the key rather than an empty string. */}
			<div className="mxd-settings-field">
				<span className="mxd-settings-label">{t("settings.rootAuth")}</span>
				{!authInheriting && (
					<select
						className="mxd-select mxd-settings-input"
						value={defaultAuth}
						onChange={(e) => onDraftChange({ defaultAuth: e.target.value })}
					>
						{rootAuthOptions.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				)}
				{!isGlobal && (
					<InheritToggle
						field="defaultAuth"
						inherited={inheritedAuth}
						valueOnUntick={inheritedAuth ?? ""}
						draft={draft}
						onDraftChange={onDraftChange}
					/>
				)}
			</div>

			{/* Root Model. Inheriting hides the input — the tickbox plus the
			    inherited value IS the state, so an empty box can no longer be the
			    way it is shown. */}
			<div className="mxd-settings-field">
				<span className="mxd-settings-label">{t("settings.rootModel")}</span>
				{!modelInheriting && (
					<input
						type="text"
						className="mxd-settings-input"
						placeholder={t("settings.rootModelPlaceholder")}
						value={model}
						onChange={(e) => onDraftChange({ model: e.target.value })}
					/>
				)}
				{!isGlobal && (
					<InheritToggle
						field="model"
						inherited={inheritedModel}
						valueOnUntick={inheritedModel ?? ""}
						draft={draft}
						onDraftChange={onDraftChange}
					/>
				)}
			</div>
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
	const [apiKeyValue, setApiKeyValue] = useState(group.apiKey ?? "");
	const [oauthToken, setOauthToken] = useState(group.oauthToken ?? "");
	const [accessToken, setAccessToken] = useState(group.accessToken ?? "");
	const [refreshToken, setRefreshToken] = useState(group.refreshToken ?? "");
	const [accountId, setAccountId] = useState(group.accountId ?? "");
	const [baseUrl, setBaseUrl] = useState(group.baseUrl ?? "");
	const [systemPreamble, setSystemPreamble] = useState(
		group.systemPreamble ?? "",
	);

	const handleSave = () => {
		const g: AuthGroup = { provider };
		if (provider === "anthropic") {
			if (apiKeyValue) g.apiKey = apiKeyValue;
			if (oauthToken) g.oauthToken = oauthToken;
			if (systemPreamble) g.systemPreamble = systemPreamble;
			if (baseUrl) g.baseUrl = baseUrl;
		} else {
			if (apiKeyValue) g.apiKey = apiKeyValue;
			if (accessToken) g.accessToken = accessToken;
			if (refreshToken) g.refreshToken = refreshToken;
			if (accountId) g.accountId = accountId;
			if (baseUrl) g.baseUrl = baseUrl;
		}
		onSave(editName.trim() || name, g);
	};

	return (
		<div className="mxd-auth-editor">
			<label className="mxd-settings-field">
				<span className="mxd-settings-label">{t("settings.authName")}</span>
				<input
					type="text"
					className="mxd-settings-input"
					value={editName}
					onChange={(e) => setEditName(e.target.value)}
				/>
			</label>
			<label className="mxd-settings-field">
				<span className="mxd-settings-label">{t("settings.authProvider")}</span>
				<select
					className="mxd-select mxd-settings-input"
					value={provider}
					onChange={(e) =>
						setProvider(e.target.value as "anthropic" | "openai")
					}
				>
					<option value="anthropic">{t("settings.providerAnthropic")}</option>
					<option value="openai">{t("settings.providerOpenAI")}</option>
				</select>
			</label>
			<label className="mxd-settings-field">
				<span className="mxd-settings-label">{t("settings.apiKey")}</span>
				<input
					type="password"
					className="mxd-settings-input"
					placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
					value={apiKeyValue}
					onChange={(e) => setApiKeyValue(e.target.value)}
				/>
			</label>
			{provider === "anthropic" ? (
				<>
					<label className="mxd-settings-field">
						<span className="mxd-settings-label">
							{t("settings.oauthToken")}
						</span>
						<input
							type="password"
							className="mxd-settings-input"
							placeholder={t("settings.optionalFallback")}
							value={oauthToken}
							onChange={(e) => setOauthToken(e.target.value)}
						/>
					</label>
					<label className="mxd-settings-field">
						<span className="mxd-settings-label">
							{t("settings.systemPreamble")}
						</span>
						<input
							type="text"
							className="mxd-settings-input"
							placeholder={t("settings.systemPreamblePlaceholder")}
							value={systemPreamble}
							onChange={(e) => setSystemPreamble(e.target.value)}
						/>
					</label>
					<label className="mxd-settings-field">
						<span className="mxd-settings-label">{t("settings.baseUrl")}</span>
						<input
							type="text"
							className="mxd-settings-input"
							placeholder="https://api.anthropic.com"
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
						/>
					</label>
				</>
			) : (
				<>
					<label className="mxd-settings-field">
						<span className="mxd-settings-label">
							{t("settings.accessToken")}
						</span>
						<input
							type="password"
							className="mxd-settings-input"
							placeholder={t("settings.optionalFallback")}
							value={accessToken}
							onChange={(e) => setAccessToken(e.target.value)}
						/>
					</label>
					<label className="mxd-settings-field">
						<span className="mxd-settings-label">
							{t("settings.refreshToken")}
						</span>
						<input
							type="password"
							className="mxd-settings-input"
							placeholder={t("settings.optionalFallback")}
							value={refreshToken}
							onChange={(e) => setRefreshToken(e.target.value)}
						/>
					</label>
					<label className="mxd-settings-field">
						<span className="mxd-settings-label">
							{t("settings.accountId")}
						</span>
						<input
							type="text"
							className="mxd-settings-input"
							placeholder={t("settings.optionalFallback")}
							value={accountId}
							onChange={(e) => setAccountId(e.target.value)}
						/>
					</label>
					<label className="mxd-settings-field">
						<span className="mxd-settings-label">{t("settings.baseUrl")}</span>
						<input
							type="text"
							className="mxd-settings-input"
							placeholder="https://api.openai.com/v1"
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
						/>
					</label>
				</>
			)}
			<div className="mxd-auth-editor-actions">
				<button
					type="button"
					className="mxd-btn mxd-btn-sm mxd-btn-primary"
					onClick={handleSave}
				>
					{t("settings.save")}
				</button>
				<button type="button" className="mxd-btn mxd-btn-sm" onClick={onCancel}>
					{t("settings.cancel")}
				</button>
				{onDelete && (
					<button
						type="button"
						className="mxd-btn mxd-btn-sm mxd-btn-danger"
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
			group.apiKey ||
			group.oauthToken ||
			group.accessToken ||
			group.refreshToken ||
			group.accountId;
		if (!key) return "—";
		return `${key.slice(0, 6)}…${key.slice(-4)}`;
	};

	return (
		<div className="mxd-settings-auth-groups">
			<div className="mxd-settings-label mxd-settings-auth-groups-title">
				{t("settings.authGroups")}
			</div>
			{Object.entries(authGroups).map(([name, group]) => (
				<div key={name} className="mxd-auth-group-row">
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
							className="mxd-auth-group-item"
							onClick={() => {
								setEditingGroup(name);
								setAddingNew(false);
							}}
						>
							<span className="mxd-auth-group-name">{name}</span>
							<span className="mxd-auth-group-provider">
								<span className="mxd-auth-group-badge">{group.provider}</span>
								<span className="mxd-auth-group-key">{maskedKey(group)}</span>
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
					className="mxd-btn mxd-btn-sm"
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
	const [newEnv, setNewEnv] = useState("");

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
		const env: Record<string, string> = {};
		for (const line of newEnv.trim().split("\n").filter(Boolean)) {
			const eq = line.indexOf("=");
			if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
		}
		const server: McpServerConfig = {
			command: newCommand.trim(),
			...(args.length > 0 ? { args } : {}),
			...(Object.keys(env).length > 0 ? { env } : {}),
		};
		onDraftChange({ mcpServers: { ...servers, [newName.trim()]: server } });
		setNewName("");
		setNewCommand("");
		setNewArgs("");
		setNewEnv("");
		setAddingNew(false);
	};

	return (
		<div className="mxd-settings-section">
			<div className="mxd-settings-section-title">
				{t("settings.mcpServers")}
			</div>

			{/* Inherited servers (read-only) */}
			{Object.entries(inheritedServers)
				.filter(([n]) => !(n in servers))
				.map(([name, srv]) => (
					<div
						key={name}
						className="mxd-mcp-server-row mxd-mcp-server-inherited"
					>
						<span className="mxd-mcp-server-name">{name}</span>
						<span className="mxd-mcp-server-cmd">
							{srv.command}
							{srv.env && Object.keys(srv.env).length > 0 && (
								<span className="mxd-mcp-server-env-badge">
									{Object.keys(srv.env)
										.map((k) => `${k}=***`)
										.join(", ")}
								</span>
							)}
						</span>
						<span className="mxd-mcp-server-inherited-badge">
							{t("settings.inherited")}
						</span>
					</div>
				))}

			{/* This layer's servers */}
			{Object.entries(servers).map(([name, srv]) => (
				<div key={name} className="mxd-mcp-server-row">
					<span className="mxd-mcp-server-name">{name}</span>
					<span className="mxd-mcp-server-cmd">
						{srv.command}
						{srv.env && Object.keys(srv.env).length > 0 && (
							<span className="mxd-mcp-server-env-badge">
								{Object.keys(srv.env)
									.map((k) => `${k}=***`)
									.join(", ")}
							</span>
						)}
					</span>
					<button
						type="button"
						className="mxd-btn-icon mxd-mcp-server-delete"
						onClick={() => deleteServer(name)}
						title={t("settings.delete")}
					>
						<IconTrash size={10} />
					</button>
				</div>
			))}

			{addingNew ? (
				<div className="mxd-mcp-server-add-form">
					<input
						type="text"
						className="mxd-settings-input"
						placeholder={t("settings.mcpServerName")}
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
					/>
					<input
						type="text"
						className="mxd-settings-input"
						placeholder={t("settings.mcpServerCommand")}
						value={newCommand}
						onChange={(e) => setNewCommand(e.target.value)}
					/>
					<input
						type="text"
						className="mxd-settings-input"
						placeholder={t("settings.mcpServerArgs")}
						value={newArgs}
						onChange={(e) => setNewArgs(e.target.value)}
					/>
					<textarea
						className="mxd-settings-input mxd-mcp-env-textarea"
						placeholder={t("settings.mcpServerEnv")}
						value={newEnv}
						onChange={(e) => setNewEnv(e.target.value)}
						rows={2}
					/>
					<div className="mxd-auth-editor-actions">
						<button
							type="button"
							className="mxd-btn mxd-btn-sm mxd-btn-primary"
							onClick={addServer}
						>
							{t("settings.save")}
						</button>
						<button
							type="button"
							className="mxd-btn mxd-btn-sm"
							onClick={() => {
								setAddingNew(false);
								setNewName("");
								setNewCommand("");
								setNewArgs("");
								setNewEnv("");
							}}
						>
							{t("settings.cancel")}
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					className="mxd-btn mxd-btn-sm"
					onClick={() => setAddingNew(true)}
				>
					<IconPlus size={11} /> {t("settings.addMcpServer")}
				</button>
			)}
		</div>
	);
}

// ---- Cache TTL Section ----

export function CacheTtlSection({
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

	const cacheTtl = (draft.cacheTtl ?? {}) as {
		root?: string;
		child?: string;
	};

	// Inherited values for non-global tabs
	const inherited = (() => {
		if (tab === "global") return { root: undefined, child: undefined };
		const lower =
			tab === "local"
				? {
						...((layers.global.cacheTtl ?? {}) as {
							root?: string;
							child?: string;
						}),
						...((layers.repo.cacheTtl ?? {}) as {
							root?: string;
							child?: string;
						}),
					}
				: ((layers.global.cacheTtl ?? {}) as {
						root?: string;
						child?: string;
					});
		return { root: lower.root, child: lower.child };
	})();

	const rootValue = cacheTtl.root ?? "";
	const childValue = cacheTtl.child ?? "";

	const handleChange = (field: "root" | "child", value: string) => {
		const updated = { ...cacheTtl };
		if (value) {
			updated[field] = value;
		} else {
			delete updated[field];
		}
		// If both fields are empty/cleared, remove the entire cacheTtl key
		if (!updated.root && !updated.child) {
			onDraftChange({ cacheTtl: undefined });
		} else {
			onDraftChange({ cacheTtl: updated });
		}
	};

	return (
		<div className="mxd-settings-section">
			<div className="mxd-settings-section-title">
				{t("settings.sectionCache")}
			</div>

			{/* Root Cache TTL — default is 1h */}
			<div className="mxd-settings-field">
				<span className="mxd-settings-label">{t("settings.cacheTtlRoot")}</span>
				<select
					className="mxd-select mxd-settings-input"
					value={rootValue}
					onChange={(e) => handleChange("root", e.target.value)}
				>
					{tab !== "global" && (
						<option value="">
							{t("settings.inheritOption")}
							{inherited.root
								? ` (${inherited.root === "1h" ? t("settings.cacheTtl1h") : t("settings.cacheTtl5m")})`
								: ""}
						</option>
					)}
					<option value="1h">{t("settings.cacheTtl1hDefault")}</option>
					<option value="5m">{t("settings.cacheTtl5m")}</option>
				</select>
			</div>

			{/* Child Cache TTL — default is 5m */}
			<div className="mxd-settings-field">
				<span className="mxd-settings-label">
					{t("settings.cacheTtlChild")}
				</span>
				<select
					className="mxd-select mxd-settings-input"
					value={childValue}
					onChange={(e) => handleChange("child", e.target.value)}
				>
					{tab !== "global" && (
						<option value="">
							{t("settings.inheritOption")}
							{inherited.child
								? ` (${inherited.child === "1h" ? t("settings.cacheTtl1h") : t("settings.cacheTtl5m")})`
								: ""}
						</option>
					)}
					<option value="5m">{t("settings.cacheTtl5mDefault")}</option>
					<option value="1h">{t("settings.cacheTtl1h")}</option>
				</select>
			</div>
		</div>
	);
}

// ---- Thinking Effort Section ----

function ThinkingEffortSection({
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

	// Compute inherited value for non-global tabs
	const inherited = (() => {
		if (tab === "global") return undefined;
		if (tab === "local") {
			const rv = layers.repo.thinkingEffort;
			if (rv !== undefined) return rv as number;
			const gv = layers.global.thinkingEffort;
			if (gv !== undefined) return gv as number;
			return undefined;
		}
		// project
		const gv = layers.global.thinkingEffort;
		return gv !== undefined ? (gv as number) : undefined;
	})();

	const value = draft.thinkingEffort as number | undefined;
	const selectValue = value !== undefined ? String(value) : "";

	const effortLabel = (v: number | undefined): string => {
		if (v === undefined) return "";
		if (v === 0) return t("settings.thinkingDisabled");
		if (v <= 25) return t("settings.thinkingLow");
		if (v <= 50) return t("settings.thinkingMedium");
		if (v <= 75) return t("settings.thinkingHigh");
		return t("settings.thinkingMax");
	};

	return (
		<div className="mxd-settings-section">
			<div className="mxd-settings-section-title">
				{t("settings.sectionThinking")}
			</div>
			<div className="mxd-settings-field">
				<span className="mxd-settings-label">
					{t("settings.thinkingEffort")}
				</span>
				<select
					className="mxd-select mxd-settings-input"
					value={selectValue}
					onChange={(e) => {
						const v = e.target.value;
						onDraftChange({
							thinkingEffort: v === "" ? undefined : Number(v),
						});
					}}
				>
					{tab !== "global" && (
						<option value="">
							{t("settings.inheritOption")}
							{inherited !== undefined ? ` (${effortLabel(inherited)})` : ""}
						</option>
					)}
					<option value="0">{t("settings.thinkingDisabled")}</option>
					<option value="25">{t("settings.thinkingLow")}</option>
					<option value="50">{t("settings.thinkingMedium")}</option>
					<option value="75">{t("settings.thinkingHigh")}</option>
					<option value="100">{t("settings.thinkingMax")}</option>
				</select>
			</div>
		</div>
	);
}

// ---- Shared Save & Restart bar (replaces per-tab Save/Revert) ----

function RestartBar({
	onSaveAndRestart,
	onRevertAll,
	hasUnsavedChanges,
	restarting,
	error,
}: {
	onSaveAndRestart: () => void;
	onRevertAll: () => void;
	hasUnsavedChanges: boolean;
	restarting: boolean;
	error?: string | null;
}) {
	const { t } = useLocale();
	return (
		<div className="mxd-settings-tab-actions">
			{error && (
				<div className="mxd-settings-save-error" role="alert">
					{t("settings.saveError")}: {error}
				</div>
			)}
			<button
				type="button"
				className="mxd-btn mxd-btn-sm mxd-btn-primary"
				disabled={restarting}
				onClick={onSaveAndRestart}
			>
				{restarting ? (
					<>
						<span className="mxd-spinner" />{" "}
						{t("settings.restartDaemonRestarting")}
					</>
				) : (
					<>
						<IconRefresh size={12} /> {t("settings.restartDaemon")}
					</>
				)}
			</button>
			<button
				type="button"
				className={`mxd-btn mxd-btn-sm ${hasUnsavedChanges ? "mxd-btn-warning" : "mxd-btn-ghost"}`}
				disabled={!hasUnsavedChanges || restarting}
				onClick={onRevertAll}
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
	theme,
	onThemeChange,
}: {
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
	theme: string;
	onThemeChange: (theme: string) => void;
}) {
	const { locale, setLocale, t } = useLocale();

	const tab: ActiveTab = "global";
	const authGroupNames = Object.keys(
		(layers.global.authGroups ?? {}) as Record<string, unknown>,
	);

	return (
		<div className="mxd-tab-content">
			{/* Language & Theme — client-side prefs, take effect immediately */}
			<div className="mxd-settings-section">
				<div className="mxd-settings-section-title">
					{t("settings.sectionAppearance")}
				</div>
				<div className="mxd-settings-field">
					<span className="mxd-settings-label">{t("lang.selector")}</span>
					<div className="mxd-settings-toggle-group">
						<button
							type="button"
							className={`mxd-settings-toggle-option${locale === "en" ? " active" : ""}`}
							onClick={() => setLocale("en")}
						>
							{t("lang.en")}
						</button>
						<button
							type="button"
							className={`mxd-settings-toggle-option${locale === "zh" ? " active" : ""}`}
							onClick={() => setLocale("zh")}
						>
							{t("lang.zh")}
						</button>
					</div>
				</div>
				<div className="mxd-settings-field">
					<span className="mxd-settings-label">{t("theme.selector")}</span>
					<div className="mxd-settings-toggle-group">
						{(
							[
								["dark", t("theme.dark")],
								["light", t("theme.light")],
								["cute-light", t("theme.cuteLight")],
								["cute-dark", t("theme.cuteDark")],
							] as const
						).map(([val, label]) => (
							<button
								key={val}
								type="button"
								className={`mxd-settings-toggle-option${theme === val ? " active" : ""}`}
								onClick={() => onThemeChange(val)}
							>
								{label}
							</button>
						))}
					</div>
				</div>
			</div>

			<AuthGroupsSection draft={draft} onDraftChange={onDraftChange} />

			<ModelsAuthSection
				layer="global"
				layers={layers}
				authGroupNames={authGroupNames}
				draft={draft}
				onDraftChange={onDraftChange}
			/>

			<McpServersSection
				tab={tab}
				layers={layers}
				draft={draft}
				onDraftChange={onDraftChange}
			/>

			<CacheTtlSection
				tab={tab}
				layers={layers}
				draft={draft}
				onDraftChange={onDraftChange}
			/>

			<ThinkingEffortSection
				tab={tab}
				layers={layers}
				draft={draft}
				onDraftChange={onDraftChange}
			/>

			<div className="mxd-settings-section">
				<div className="mxd-settings-section-title">
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
			</div>
		</div>
	);
}

function ProjectTab({
	tab,
	layers,
	draft,
	onDraftChange,
}: {
	tab: "project" | "local";
	layers: ThreeLayerConfig;
	draft: Record<string, unknown>;
	onDraftChange: (patch: Record<string, unknown>) => void;
}) {
	const { t } = useLocale();
	const authGroupNames = Object.keys(
		(layers.global.authGroups ?? {}) as Record<string, unknown>,
	);

	return (
		<div className="mxd-tab-content">
			<ModelsAuthSection
				layer={tab}
				layers={layers}
				authGroupNames={authGroupNames}
				draft={draft}
				onDraftChange={onDraftChange}
			/>

			<div className="mxd-settings-section">
				<div className="mxd-settings-section-title">
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

				<SettingBoolField
					label={t("settings.selfBootstrap")}
					field="selfBootstrap"
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

			<CacheTtlSection
				tab={tab}
				layers={layers}
				draft={draft}
				onDraftChange={onDraftChange}
			/>

			<ThinkingEffortSection
				tab={tab}
				layers={layers}
				draft={draft}
				onDraftChange={onDraftChange}
			/>
		</div>
	);
}

// ---- Build diff patch: only send fields that changed ----

/**
 * Build a PATCH body from draft vs saved config.
 *
 * @param allowNull - When true (default, for project/local layers), sends null
 *   for fields in saved but missing from draft (meaning "remove this override").
 *   When false (for global layer), omits such fields — global config requires all
 *   fields, and null is rejected by the server. FIX-10: this flag closes the
 *   "save then restart, changes gone" bug where buildPatch sent null for fields
 *   the user didn't touch, causing a 400 that updateConfig silently swallowed.
 */
function buildPatch(
	draft: Record<string, unknown>,
	saved: Record<string, unknown>,
	allowNull = true,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	// Fields in draft that differ from saved
	for (const key of Object.keys(draft)) {
		const dv = draft[key];
		const sv = saved[key];
		if (JSON.stringify(dv) !== JSON.stringify(sv)) {
			if (dv === undefined) {
				// Draft has the key but value is undefined — for global, omit;
				// for project/local, send null to clear the override.
				if (allowNull) patch[key] = null;
			} else {
				patch[key] = dv;
			}
		}
	}
	// Fields in saved but missing/removed from draft — send null to clear override.
	// Only for project/local layers (allowNull=true). For global, omit entirely —
	// the server rejects null on required global fields.
	if (allowNull) {
		for (const key of Object.keys(saved)) {
			if (!(key in draft) && saved[key] !== undefined) {
				patch[key] = null;
			}
		}
	}
	return patch;
}

// ---- Main SettingsPanel ----

export const SettingsPanel = memo(function SettingsPanel({
	layers,
	loading,
	theme,
	onThemeChange,
	updateGlobal,
	updateRepo,
	updateLocal,
	onClose,
	onDeleteProject,
}: {
	projectId: string;
	layers: ThreeLayerConfig;
	loading: boolean;
	theme: string;
	onThemeChange: (theme: string) => void;
	updateGlobal: (patch: Record<string, unknown>) => Promise<string | null>;
	updateRepo: (patch: Record<string, unknown>) => Promise<string | null>;
	updateLocal: (patch: Record<string, unknown>) => Promise<string | null>;
	onClose: () => void;
	onDeleteProject?: () => void;
}) {
	const { t } = useLocale();
	const authFetch = useAuthFetch();
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
	const hasUnsavedChanges = dirtyGlobal || dirtyRepo || dirtyLocal;

	// Save error state — surfaced inline when PATCH fails
	const [saveError, setSaveError] = useState<string | null>(null);

	// ---- Save & Restart: save ALL dirty tabs then restart daemon ----
	const [restarting, setRestarting] = useState(false);
	const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Cleanup polling on unmount
	useEffect(() => {
		return () => {
			if (pollingRef.current) clearInterval(pollingRef.current);
		};
	}, []);

	const handleSaveAndRestart = useCallback(async () => {
		setSaveError(null);

		// Save each dirty tab; stop on first error
		if (dirtyGlobal) {
			const model = (draftGlobal.model as string | undefined) ?? "";
			if (!model.trim()) {
				window.alert(t("settings.modelRequired"));
				return;
			}
			const patch = buildPatch(draftGlobal, layers.global, false);
			if (Object.keys(patch).length > 0) {
				const err = await updateGlobal(patch);
				if (err) {
					setSaveError(err);
					return;
				}
			}
		}
		// An UNTICKED-but-empty override would write `""`, which overrides a real
		// global value with an empty string — for model that now reaches the API
		// (no fallback substitutes one any more), and for defaultAuth it means
		// "this project has no auth group". Ticking Inherit is how you clear an
		// override; an empty control is not. Both project layers are checked,
		// because either door can author the same value.
		for (const draftLayer of [draftRepo, draftLocal]) {
			for (const field of ["model", "defaultAuth"] as const) {
				const override = draftLayer[field] as string | undefined;
				if (override !== undefined && !override.trim()) {
					window.alert(
						t("settings.overrideEmpty", {
							field: t(
								field === "model" ? "settings.rootModel" : "settings.rootAuth",
							),
						}),
					);
					return;
				}
			}
		}
		if (dirtyRepo) {
			const patch = buildPatch(draftRepo, layers.repo);
			if (Object.keys(patch).length > 0) {
				const err = await updateRepo(patch);
				if (err) {
					setSaveError(err);
					return;
				}
			}
		}
		if (dirtyLocal) {
			const patch = buildPatch(draftLocal, layers.local);
			if (Object.keys(patch).length > 0) {
				const err = await updateLocal(patch);
				if (err) {
					setSaveError(err);
					return;
				}
			}
		}

		// All saves succeeded (or nothing to save) — restart daemon
		setRestarting(true);
		authFetch("/restart-daemon", { method: "POST" }).catch(() => {});

		// Poll every 1s until daemon is back, then reload
		setTimeout(() => {
			pollingRef.current = setInterval(async () => {
				try {
					const res = await authFetch("/health");
					if (res.ok) {
						if (pollingRef.current) clearInterval(pollingRef.current);
						pollingRef.current = null;
						window.location.reload();
					}
				} catch {
					// Expected while daemon is down
				}
			}, 1000);
		}, 1500);
	}, [
		dirtyGlobal,
		dirtyRepo,
		dirtyLocal,
		draftGlobal,
		draftRepo,
		draftLocal,
		layers,
		updateGlobal,
		updateRepo,
		updateLocal,
		authFetch,
		t,
	]);

	const tabTitleKey = {
		global: "settings.titleGlobal",
		project: "settings.titleProject",
		local: "settings.titleLocal",
	} as const;

	// Revert all tabs to last-saved state
	const handleRevertAll = useCallback(() => {
		setDraftGlobal({ ...layers.global });
		setDraftRepo({ ...layers.repo });
		setDraftLocal({ ...layers.local });
		setSaveError(null);
	}, [layers]);

	// Click-outside-to-close (exclude the gear toggle button in the header)
	const panelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (panelRef.current?.contains(target)) return;
			if ((target as Element).closest?.(".mxd-settings-toggle-btn")) return;
			if ((target as Element).closest?.(".mxd-sidebar-settings-btn")) return;
			onClose();
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [onClose]);

	return (
		<div ref={panelRef} className="mxd-settings-panel mxd-settings-panel-wide">
			<div className="mxd-settings-header">
				<span className="mxd-settings-title">{t(tabTitleKey[activeTab])}</span>
				<button type="button" className="mxd-btn-icon" onClick={onClose}>
					<IconClose size={11} />
				</button>
			</div>

			{loading && (
				<div className="mxd-settings-loading">{t("settings.loading")}</div>
			)}

			{/* Tab buttons */}
			<div className="mxd-settings-tabs">
				<button
					type="button"
					className={`mxd-settings-tab mxd-settings-tab-global${activeTab === "global" ? " mxd-settings-tab-active mxd-settings-tab-active-global" : ""}`}
					onClick={() => setActiveTab("global")}
				>
					{t("settings.tabGlobal")}
					{dirtyGlobal && <span className="mxd-settings-dirty">*</span>}
				</button>
				<button
					type="button"
					className={`mxd-settings-tab mxd-settings-tab-project${activeTab === "project" ? " mxd-settings-tab-active mxd-settings-tab-active-project" : ""}`}
					onClick={() => setActiveTab("project")}
				>
					{t("settings.tabProject")}
					{dirtyRepo && <span className="mxd-settings-dirty">*</span>}
				</button>
				<button
					type="button"
					className={`mxd-settings-tab mxd-settings-tab-local${activeTab === "local" ? " mxd-settings-tab-active mxd-settings-tab-active-local" : ""}`}
					onClick={() => setActiveTab("local")}
				>
					{t("settings.tabLocal")}
					{dirtyLocal && <span className="mxd-settings-dirty">*</span>}
				</button>
			</div>

			{/* Tab content */}
			{activeTab === "global" && (
				<GlobalTab
					layers={layers}
					draft={draftGlobal}
					onDraftChange={updateDraftGlobal}
					theme={theme}
					onThemeChange={onThemeChange}
				/>
			)}
			{activeTab === "project" && (
				<ProjectTab
					tab="project"
					layers={layers}
					draft={draftRepo}
					onDraftChange={updateDraftRepo}
				/>
			)}
			{activeTab === "local" && (
				<ProjectTab
					tab="local"
					layers={layers}
					draft={draftLocal}
					onDraftChange={updateDraftLocal}
				/>
			)}

			<RestartBar
				onSaveAndRestart={handleSaveAndRestart}
				onRevertAll={handleRevertAll}
				hasUnsavedChanges={hasUnsavedChanges}
				restarting={restarting}
				error={saveError}
			/>

			{onDeleteProject && (
				<div className="mxd-settings-danger-zone">
					<div className="mxd-settings-section-title">
						{t("settings.dangerZone")}
					</div>
					<p className="mxd-settings-danger-description">
						{t("settings.removeProjectDescription")}
					</p>
					<button
						type="button"
						className="mxd-btn mxd-btn-danger"
						onClick={onDeleteProject}
					>
						<IconTrash size={12} /> {t("settings.removeProject")}
					</button>
				</div>
			)}
		</div>
	);
});
