import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AnthropicAuthGroup {
	provider: "anthropic";
	apiKey?: string;
	oauthToken?: string;
	/** Prepended as the first system text block when non-empty. */
	systemPreamble?: string;
	/** API base URL override (SDK `baseURL`). When unset, the SDK default applies. */
	baseUrl?: string;
}

/**
 * Two credential sources, mutually exclusive.
 *
 * - `apiKey` — a platform API key, for `api.openai.com`.
 * - `authJsonPath` — a path to the `auth.json` the `codex` CLI maintains, for
 *   the codex endpoint. We only ever READ it.
 *
 * ⚠️ The two do not cross: the ChatGPT OAuth token in `auth.json` lacks the
 * scope the platform API requires, and a platform key is not what the codex
 * endpoint accepts.
 *
 * ⭐ There is deliberately no `accessToken` / `refreshToken` here, and the
 * reason is ownership rather than convenience (user, 2026-07-29). OpenAI
 * ROTATES the refresh token on every refresh, so a second copy of the pair is
 * not a snapshot that goes stale — it is a competitor for one chain, and
 * whichever side refreshes first invalidates the other. Measured on this
 * machine: the copy in our config and the one in `~/.codex/auth.json` had
 * DIFFERENT access and refresh tokens, and both were dead. The chain belongs to
 * the `codex` CLI; we are a reader of the file it writes.
 */
export interface OpenAIAuthGroup {
	provider: "openai";
	apiKey?: string;
	/** Path to codex's `auth.json`. Read at every use — never cached, because
	 * codex refreshes it behind us and a cache is the copy problem again. */
	authJsonPath?: string;
	baseUrl?: string;
}

export type AuthGroup = AnthropicAuthGroup | OpenAIAuthGroup;

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

/** Valid cache TTL values. */
export type CacheTtl = "5m" | "1h";

/**
 * Matrix global config — fully specified, no optional fields. It is the BASE
 * every overlay sits on, so "not chosen yet" is a present-but-empty value here
 * (`model: ""`), never an absent key.
 *
 * The two project layers are `RepoConfig` and `LocalConfig` below. They are
 * NOT `Partial<MatrixConfig>`: each has its own field set.
 */
export interface MatrixConfig {
	authGroups: Record<string, AuthGroup>;
	defaultAuth: string;
	model: string;

	/** Budget per agent in USD. -1 = unlimited. */
	budgetUsd: number;
	mcpServers: Record<string, McpServerConfig>;
	port: number;
	selfBootstrap: boolean;
	/** Thinking effort level (0-100). 0 = disabled, 1-100 = enabled at varying depth. undefined = provider default (no thinking). */
	thinkingEffort: number;
	/** Cache TTL configuration. */
	cacheTtl: {
		root: CacheTtl;
		child: CacheTtl;
	};
}

/**
 * The two per-project config layers, by where their file lives.
 *
 * | layer | file | reaches you via |
 * |---|---|---|
 * | `repo` | `<projectPath>/.mxd/config.json` | git — it arrives with `git clone` |
 * | `local` | `<dataDir>/projects/<id>/config.json` | only ever written on this machine |
 */
export type ProjectLayer = "repo" | "local";

/**
 * Which project layers may carry each config field.
 *
 * ⭐ This is the ONE declaration of the layers' field sets: `RepoConfig`,
 * `LocalConfig` and the key lists the loaders project onto are all computed
 * from it, so a field's classification and its type cannot disagree. The
 * `satisfies Record<keyof MatrixConfig, …>` makes adding a field to
 * `MatrixConfig` without classifying it here a compile error.
 *
 * ⚠️ `repo: false` on `model` and `defaultAuth` is a statement about TRUST, not
 * about scope (user, 2026-07-29): the repo layer is git-tracked and arrives with
 * a clone, so a repo you cloned would otherwise choose the model, the auth group
 * and — via `authGroups`, which `resolveConfig` replaces wholesale rather than
 * merging — the credentials every later agent run uses. The local layer never
 * enters a repo, so it is as trusted as global; `defaultAuth` there is also only
 * the NAME of a group that must already exist in the user's own global config,
 * so nothing can be injected by setting it.
 *
 * ⚠️ `authGroups` and `port` are `false` everywhere for a DIFFERENT reason:
 * they are global-only. `authGroups` happens to be both, and the two reasons
 * must stay apart — `port` is global-only and has nothing to do with trust,
 * `model` is untrusted from the repo and is not global-only.
 */
const CONFIG_FIELD_LAYERS = {
	// Global only.
	authGroups: { repo: false, local: false },
	port: { repo: false, local: false },

	// Global + local. Not from the repo — see the trust note above.
	defaultAuth: { repo: false, local: true },
	model: { repo: false, local: true },

	// Any layer.
	budgetUsd: { repo: true, local: true },
	mcpServers: { repo: true, local: true },
	selfBootstrap: { repo: true, local: true },
	thinkingEffort: { repo: true, local: true },
	cacheTtl: { repo: true, local: true },
} as const satisfies Record<keyof MatrixConfig, Record<ProjectLayer, boolean>>;

type FieldsIn<L extends ProjectLayer> = {
	[K in keyof typeof CONFIG_FIELD_LAYERS]: (typeof CONFIG_FIELD_LAYERS)[K][L] extends true
		? K
		: never;
}[keyof typeof CONFIG_FIELD_LAYERS];

/** What one project layer may carry. Every field optional: absent = inherit. */
export type LayerConfig<L extends ProjectLayer> = Partial<
	Pick<MatrixConfig, FieldsIn<L>>
>;

export type RepoConfig = LayerConfig<"repo">;
export type LocalConfig = LayerConfig<"local">;

/**
 * The table as a runtime lookup.
 *
 * ⚠️ A Map rather than property access on the object literal:
 * `CONFIG_FIELD_LAYERS["__proto__"]` answers with `Object.prototype`, which is
 * truthy, so every prototype-chain name (`__proto__`, `constructor`,
 * `toString`) would resolve to a bogus entry and get classified by whichever
 * branch its undefined flags happened to fall into. `Map.get` sees own entries
 * only. It matters beyond the wrong sentence: `JSON.parse` yields `__proto__` as
 * an OWN key, and a key that reaches the object `asLayerConfig` builds is
 * ASSIGNED to it, where `__proto__` is a setter rather than a property.
 */
const FIELD_LAYERS: ReadonlyMap<
	string,
	Record<ProjectLayer, boolean>
> = new Map(Object.entries(CONFIG_FIELD_LAYERS));

/** Fields no project layer may carry — they exist only in global config. */
export const GLOBAL_ONLY_FIELDS: readonly string[] = [...FIELD_LAYERS]
	.filter(([, layers]) => !layers.repo && !layers.local)
	.map(([key]) => key);

/**
 * Why `key` may not live in `layer`, or `null` if it may.
 *
 * One sentence, one place: the write doors (`PATCH …/config/{repo,local}`,
 * `mxd config set --project`) return it as a refusal, and the loaders log it
 * when they drop a key on read — so a user meets the same explanation whichever
 * path they took, and neither door holds its own field list.
 */
export function configFieldRefusal(
	layer: ProjectLayer,
	key: string,
): string | null {
	const layers = FIELD_LAYERS.get(key);
	if (!layers) return `"${key}" is not a config field.`;
	if (layers[layer]) return null;
	if (!layers.repo && !layers.local) {
		return `"${key}" can only be set in global config.`;
	}
	// Everything left is settable somewhere and not here, and `layer` can only be
	// "repo": repo ⊆ local always holds — a field the repo layer may set but the
	// local one may not would be backwards, since local is the trusted side. That
	// containment is asserted in `config.test.ts` rather than branched on here, so
	// a classification that broke it reddens instead of getting a wrong sentence.
	return `"${key}" cannot be set in repo config — it is git-tracked and travels with a clone, so it must not choose what an agent runs with. Set it in local or global config.`;
}

/**
 * Project a parsed config object onto one layer's field set: a field this layer
 * may not have does not survive, so nothing downstream has to reject it.
 *
 * ⭐ This is where the field sets are ENFORCED, and it has to be the read
 * rather than the writes: of the three ways a field reaches the repo layer —
 * `PATCH …/config/repo`, `mxd config set --project`, and `git clone` — the
 * third has no write moment at all, so no set of write-door guards can be
 * complete.
 *
 * ⚠️ A dropped key is reported, never dropped silently: a key that was ignored
 * and a key that took effect are otherwise indistinguishable to whoever
 * hand-wrote it.
 *
 * ⚠️ A key this version does not RECOGNISE is dropped like any other, and the
 * alternative was considered and rejected (user, 2026-07-29). Carrying it —
 * because it might be a field a NEWER matrix wrote into the git-tracked file —
 * means a place to hold values this version cannot interpret and a path to write
 * them back out, i.e. a forward-compatibility mechanism, and **we have no
 * versioning to build one on.** When we do, a file from a newer version should
 * say so and ask to be updated (`01KYR23QK9E4CJDD7XKV8Q1CE5`); that is a
 * different feature, not a silent carry-through bolted onto the reader. So the
 * treatment is uniform: it does not survive, and the warning makes it visible.
 */
export function asLayerConfig<L extends ProjectLayer>(
	raw: Record<string, unknown>,
	layer: L,
	source: string,
): LayerConfig<L> {
	const kept: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const refusal = configFieldRefusal(layer, key);
		if (refusal === null) {
			kept[key] = value;
		} else {
			console.warn(`[config] dropped from ${source}: ${refusal}`);
		}
	}
	return kept as LayerConfig<L>;
}

/**
 * Default values for all MatrixConfig fields.
 *
 * Frozen at module load (top level + nested objects) to make the shared
 * singleton physically immutable. Any code that needs to mutate defaults must
 * first clone (`{ ...DEFAULT_CONFIG }`). This prevents a whole class of
 * subtle bugs where a handler mutates ctx.globalConfig in place and poisons
 * DEFAULT_CONFIG for the rest of the process.
 */
export const DEFAULT_CONFIG: MatrixConfig = Object.freeze({
	authGroups: Object.freeze({}),
	defaultAuth: "",
	model: "",

	budgetUsd: -1,
	mcpServers: Object.freeze({}),
	port: 7433,
	selfBootstrap: false,

	thinkingEffort: 0,
	cacheTtl: Object.freeze({ root: "1h", child: "5m" }),
}) as MatrixConfig;

function globalConfigPath(): string {
	return join(homedir(), ".mxd", "config.json");
}

/**
 * Read one project layer's file and project it onto that layer's field set.
 * A missing or unparseable file is an absent overlay (`{}`) — unlike global
 * config, a project layer is optional by design.
 */
async function readLayerConfig<L extends ProjectLayer>(
	path: string,
	layer: L,
): Promise<LayerConfig<L>> {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
	return asLayerConfig(raw, layer, path);
}

/**
 * Load global config. Must be a complete MatrixConfig.
 * If the file doesn't exist, returns DEFAULT_CONFIG (caller should write it).
 * If the file exists but is missing required fields, throws.
 */
export async function loadGlobalConfig(path?: string): Promise<MatrixConfig> {
	const resolvedPath = path ?? globalConfigPath();
	let text: string;
	try {
		text = await readFile(resolvedPath, "utf-8");
	} catch (e) {
		// Only a MISSING file means "fresh install → return defaults". Any other
		// read error (permission denied, IO error) is real and must surface —
		// silently returning defaults here would let the next save overwrite a
		// config that simply couldn't be read.
		if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { ...DEFAULT_CONFIG };
		}
		throw e;
	}
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(text) as Record<string, unknown>;
	} catch (e) {
		// File exists but is not valid JSON — corrupt. Surface loudly; do NOT
		// silently return defaults (that would wipe credentials on the next save).
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(
			`Global config at ${resolvedPath} is not valid JSON: ${message}`,
		);
	}
	// Validate required fields
	const missing: string[] = [];
	for (const key of Object.keys(DEFAULT_CONFIG) as (keyof MatrixConfig)[]) {
		if (raw[key] === undefined) {
			missing.push(key);
		}
	}
	if (missing.length > 0) {
		throw new Error(
			`Global config is missing required fields: ${missing.join(", ")}. ` +
				"Run `mxd config init` to create a complete config, or add the missing fields manually.",
		);
	}
	warnRemovedAuthFields(raw.authGroups, resolvedPath);
	return raw as unknown as MatrixConfig;
}

/** Fields an OpenAI auth group used to carry, with what replaces each. */
const REMOVED_OPENAI_AUTH_FIELDS: ReadonlyMap<string, string> = new Map([
	["accessToken", "authJsonPath"],
	["refreshToken", "authJsonPath"],
	["accountId", "authJsonPath (read from the file's tokens.account_id)"],
]);

/**
 * Warn about credential fields that no longer exist, naming the way forward.
 *
 * ⚠️ These do not go through `asLayerConfig`'s drop-and-warn — `authGroups` is
 * global-only, and global config is validated rather than projected, so a
 * removed field inside a group is simply never read again. Silence there is the
 * worst available outcome: the user's OpenAI calls start failing and the config
 * still visibly contains a token, so the file itself argues that it is fine.
 *
 * Warn, never repair. Rewriting the file would mean deciding on the user's
 * behalf which auth.json they meant, and this loader is also the path
 * `mxd config` reads before saving — a fix applied here would rewrite
 * credentials as a side effect of an unrelated command.
 */
function warnRemovedAuthFields(authGroups: unknown, source: string): void {
	if (!authGroups || typeof authGroups !== "object") return;
	for (const [name, group] of Object.entries(
		authGroups as Record<string, unknown>,
	)) {
		if (!group || typeof group !== "object") continue;
		for (const [field, replacement] of REMOVED_OPENAI_AUTH_FIELDS) {
			if (!Object.hasOwn(group, field)) continue;
			console.warn(
				`[config] auth group "${name}" in ${source} carries "${field}", which no longer exists. ` +
					"This was never a field that merely moved: OpenAI ROTATES the refresh token on every refresh, so a copy kept here and the codex CLI's own copy were two claimants to one chain — whichever refreshed first silently invalidated the other, and the copy stored here is almost certainly dead already. " +
					`Set "${replacement}" to the path of codex's auth.json (usually ~/.codex/auth.json) and matrix will read it at each use; run \`codex login\` if that file has expired.`,
			);
		}
	}
}

export async function saveGlobalConfig(
	config: MatrixConfig,
	path?: string,
): Promise<void> {
	const resolvedPath = path ?? globalConfigPath();
	await mkdir(dirname(resolvedPath), { recursive: true });
	await writeFile(resolvedPath, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function loadProjectRepoConfig(
	projectPath: string,
): Promise<RepoConfig> {
	return readLayerConfig(join(projectPath, ".mxd", "config.json"), "repo");
}

export async function saveProjectRepoConfig(
	projectPath: string,
	config: RepoConfig,
): Promise<void> {
	const path = join(projectPath, ".mxd", "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function loadProjectLocalConfig(
	dataDir: string,
	projectId: string,
): Promise<LocalConfig> {
	return readLayerConfig(
		join(dataDir, "projects", projectId, "config.json"),
		"local",
	);
}

export async function saveProjectLocalConfig(
	dataDir: string,
	projectId: string,
	config: LocalConfig,
): Promise<void> {
	const path = join(dataDir, "projects", projectId, "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config, null, "\t"), "utf-8");
}

/**
 * Merge the three layers. Nested objects (mcpServers, cacheTtl) shallow-merge;
 * everything else is replaced by the later layer when present.
 *
 * ⚠️ The overlay rule is `value !== undefined`, so `""` IS an overriding value
 * and an ABSENT key is what means inherit. The global config is the BASE here at
 * every call site, which is why its `model: ""` can never climb over a project's
 * choice; the reverse direction is reachable and deliberate.
 *
 * The parameters are positional and layer-typed rather than variadic: this is
 * the one function where the three layers meet, so each one says which layer it
 * is.
 */
export function resolveConfig(
	global: MatrixConfig,
	repo: RepoConfig = {},
	local: LocalConfig = {},
): MatrixConfig {
	let result = { ...global };

	for (const overlay of [repo, local] as Partial<MatrixConfig>[]) {
		// Shallow-merge nested record fields
		if (overlay.mcpServers) {
			result.mcpServers = { ...result.mcpServers, ...overlay.mcpServers };
		}
		if (overlay.cacheTtl) {
			result.cacheTtl = { ...result.cacheTtl, ...overlay.cacheTtl };
		}

		// Scalar/whole-object fields — overlay wins
		const scalarOverlay: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(overlay)) {
			if (value !== undefined && key !== "mcpServers" && key !== "cacheTtl") {
				scalarOverlay[key] = value;
			}
		}
		result = { ...result, ...scalarOverlay };
	}

	return result;
}

/**
 * Look up an auth group by name. If no name given, uses config.defaultAuth.
 * Returns null if the group doesn't exist.
 */
export function resolveAuthGroup(
	config: MatrixConfig,
	groupName?: string,
): AuthGroup | null {
	const name = groupName ?? config.defaultAuth;
	if (!name) return null;
	return config.authGroups?.[name] ?? null;
}
