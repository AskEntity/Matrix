import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AnthropicAuthGroup {
	provider: "anthropic";
	apiKey?: string;
	oauthToken?: string;
	/** Prepended as the first system text block when non-empty. */
	systemPreamble?: string;
}

export interface OpenAIAuthGroup {
	provider: "openai";
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	accountId?: string;
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
 * Matrix global config — fully specified, no optional fields.
 * Project configs (repo/local) use `Partial<MatrixConfig>` as overlays.
 */
export interface MatrixConfig {
	authGroups: Record<string, AuthGroup>;
	defaultAuth: string;
	model: string;
	/** Auth group for child agents. "parent" = use defaultAuth. */
	childAuth: "parent" | string;
	/** Model for child agents. "parent" = use model. */
	childModel: "parent" | string;
	/** Budget per agent in USD. -1 = unlimited. */
	budgetUsd: number;
	clarifyTimeoutMs: number;
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

/** Fields that can only be set in global config, not per-project. */
export const GLOBAL_ONLY_FIELDS = ["authGroups", "port"] as const;

/** Project-level config — partial overlay on global config. Excludes global-only fields. */
export type ProjectConfig = Partial<
	Omit<MatrixConfig, (typeof GLOBAL_ONLY_FIELDS)[number]>
>;

export const DEFAULT_MODEL = "claude-sonnet-4-6";

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
	model: DEFAULT_MODEL,
	childAuth: "parent",
	childModel: "parent",
	budgetUsd: -1,
	clarifyTimeoutMs: 30000,
	mcpServers: Object.freeze({}),
	port: 7433,
	selfBootstrap: false,

	thinkingEffort: 0,
	cacheTtl: Object.freeze({ root: "1h", child: "5m" }),
}) as MatrixConfig;

function globalConfigPath(): string {
	return join(homedir(), ".mxd", "config.json");
}

async function readJsonConfig(path: string): Promise<ProjectConfig> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as ProjectConfig;
	} catch {
		return {};
	}
}

/**
 * Load global config. Must be a complete MatrixConfig.
 * If the file doesn't exist, returns DEFAULT_CONFIG (caller should write it).
 * If the file exists but is missing required fields, throws.
 */
export async function loadGlobalConfig(path?: string): Promise<MatrixConfig> {
	const resolvedPath = path ?? globalConfigPath();
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(await readFile(resolvedPath, "utf-8")) as Record<
			string,
			unknown
		>;
	} catch {
		// File doesn't exist — return defaults (caller creates the file)
		return { ...DEFAULT_CONFIG };
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
	return raw as unknown as MatrixConfig;
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
): Promise<ProjectConfig> {
	return readJsonConfig(join(projectPath, ".mxd", "config.json"));
}

export async function saveProjectRepoConfig(
	projectPath: string,
	config: ProjectConfig,
): Promise<void> {
	const path = join(projectPath, ".mxd", "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function loadProjectLocalConfig(
	dataDir: string,
	projectId: string,
): Promise<ProjectConfig> {
	return readJsonConfig(join(dataDir, "projects", projectId, "config.json"));
}

export async function saveProjectLocalConfig(
	dataDir: string,
	projectId: string,
	config: ProjectConfig,
): Promise<void> {
	const path = join(dataDir, "projects", projectId, "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config, null, "\t"), "utf-8");
}

/**
 * Merge config layers. Each overlay spreads on top of the base.
 * Nested objects (mcpServers, cacheTtl) do shallow merge.
 * Scalar fields: overlay wins if defined.
 */
export function resolveConfig(
	base: MatrixConfig,
	...overlays: ProjectConfig[]
): MatrixConfig {
	let result = { ...base };

	for (const overlay of overlays) {
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
