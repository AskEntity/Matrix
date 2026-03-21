import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AuthGroup {
	provider: "anthropic" | "openai";
	anthropicApiKey?: string;
	claudeOauthToken?: string;
	openaiApiKey?: string;
	openaiBaseUrl?: string;
}

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface WebAuthnConfig {
	/** Whether passkey auth is required on the main port. Defaults to false. */
	enforced?: boolean;
	/** Relying Party display name. Defaults to "OpenGraft". */
	rpName?: string;
	/** Relying Party ID (domain). Defaults to request host. */
	rpID?: string;
}

export interface OpenGraftConfig {
	authGroups?: Record<string, AuthGroup>;
	defaultAuth?: string;
	model?: string;
	childAuth?: string;
	childModel?: string;
	budgetUsd?: number;
	maxDepth?: number;
	clarifyTimeoutMs?: number;
	mcpServers?: Record<string, McpServerConfig>;
	port?: number;
	sessionKeep?: number;
	selfBootstrap?: boolean;
	auth?: WebAuthnConfig;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";

function globalConfigPath(): string {
	return join(homedir(), ".opengraft", "config.json");
}

async function readJsonConfig(path: string): Promise<OpenGraftConfig> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as OpenGraftConfig;
	} catch {
		return {};
	}
}

export async function loadGlobalConfig(
	path?: string,
): Promise<OpenGraftConfig> {
	return readJsonConfig(path ?? globalConfigPath());
}

export async function saveGlobalConfig(
	config: OpenGraftConfig,
	path?: string,
): Promise<void> {
	const resolvedPath = path ?? globalConfigPath();
	await mkdir(dirname(resolvedPath), { recursive: true });
	await writeFile(resolvedPath, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function loadProjectRepoConfig(
	projectPath: string,
): Promise<OpenGraftConfig> {
	return readJsonConfig(join(projectPath, ".opengraft", "config.json"));
}

export async function saveProjectRepoConfig(
	projectPath: string,
	config: OpenGraftConfig,
): Promise<void> {
	const path = join(projectPath, ".opengraft", "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function loadProjectLocalConfig(
	dataDir: string,
	projectId: string,
): Promise<OpenGraftConfig> {
	return readJsonConfig(join(dataDir, "projects", projectId, "config.json"));
}

export async function saveProjectLocalConfig(
	dataDir: string,
	projectId: string,
	config: OpenGraftConfig,
): Promise<void> {
	const path = join(dataDir, "projects", projectId, "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config, null, "\t"), "utf-8");
}

/**
 * Merge three config layers: local > repo > global.
 * Scalar fields: higher priority wins (leftmost non-undefined).
 * mcpServers: union of all servers; local overrides same-named server from repo/global.
 * authGroups: union of all groups; local overrides same-named group from repo/global.
 */
export function resolveConfig(
	global: OpenGraftConfig,
	repo: OpenGraftConfig,
	local: OpenGraftConfig,
): OpenGraftConfig {
	const result: OpenGraftConfig = {};

	// Scalar fields — first defined value wins (local > repo > global)
	const scalarKeys = [
		"defaultAuth",
		"model",
		"childAuth",
		"childModel",
		"budgetUsd",
		"maxDepth",
		"clarifyTimeoutMs",
		"port",
		"sessionKeep",
		"selfBootstrap",
	] as const;

	for (const key of scalarKeys) {
		const value = local[key] ?? repo[key] ?? global[key];
		if (value !== undefined) {
			(result as Record<string, unknown>)[key] = value;
		}
	}

	// mcpServers — merge (union), local > repo > global for same-named server
	const allServers = {
		...global.mcpServers,
		...repo.mcpServers,
		...local.mcpServers,
	};
	if (Object.keys(allServers).length > 0) {
		result.mcpServers = allServers;
	}

	// authGroups — merge (union), local > repo > global for same-named group
	const allGroups = {
		...global.authGroups,
		...repo.authGroups,
		...local.authGroups,
	};
	if (Object.keys(allGroups).length > 0) {
		result.authGroups = allGroups;
	}

	// auth (WebAuthn) — merge as object, local > repo > global
	const mergedAuth = {
		...global.auth,
		...repo.auth,
		...local.auth,
	};
	if (Object.keys(mergedAuth).length > 0) {
		result.auth = mergedAuth;
	}

	return result;
}

/**
 * Whether passkey auth is enforced on the main port.
 * `enforced` takes priority. Falls back to deprecated `enabled` for backward compat.
 */
export function isAuthEnforced(auth?: WebAuthnConfig): boolean {
	return auth?.enforced ?? false;
}

/**
 * Look up an auth group by name. If no name given, uses config.defaultAuth.
 * Returns null if the group doesn't exist.
 */
export function resolveAuthGroup(
	config: OpenGraftConfig,
	groupName?: string,
): AuthGroup | null {
	const name = groupName ?? config.defaultAuth;
	if (!name) return null;
	return config.authGroups?.[name] ?? null;
}
