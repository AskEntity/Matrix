import { readFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProvider } from "../agent-provider.ts";
import { AnthropicCompatibleProvider } from "../anthropic-compatible-provider.ts";
import {
	type AuthGroup,
	loadProjectLocalConfig,
	loadProjectRepoConfig,
	type OpenGraftConfig,
	resolveAuthGroup,
	resolveConfig,
} from "../config.ts";
import { OpenAICompatibleProvider } from "../openai-compatible-provider.ts";
import { SessionStore } from "../session-store.ts";
import { TaskTracker } from "../task-tracker.ts";
import type { TaskNode } from "../types.ts";
import type { DaemonContext } from "./context.ts";

/** Create an AgentProvider from an AuthGroup and model. */
export function createProviderFromAuth(
	authGroup: AuthGroup,
	model?: string,
): AgentProvider {
	if (authGroup.provider === "anthropic") {
		return new AnthropicCompatibleProvider(model, {
			apiKey: authGroup.anthropicApiKey,
			oauthToken: authGroup.claudeOauthToken,
		});
	}
	return new OpenAICompatibleProvider(model, {
		apiKey: authGroup.openaiApiKey,
		baseUrl: authGroup.openaiBaseUrl,
	});
}

/** Create a provider from resolved config. Requires an auth group to be configured. */
export function createProviderFromConfig(
	effectiveConfig: OpenGraftConfig,
): AgentProvider {
	const authGroup = resolveAuthGroup(effectiveConfig);
	if (!authGroup) {
		throw new Error(
			"No auth group configured. Add an auth group in Settings > Global > Auth Groups and set defaultAuth.",
		);
	}
	return createProviderFromAuth(authGroup, effectiveConfig.model);
}

/** Collect a node and all its descendants. */
export function collectDescendants(
	tracker: TaskTracker,
	nodeId: string,
): TaskNode[] {
	const node = tracker.get(nodeId);
	if (!node) return [];
	const result: TaskNode[] = [node];
	for (const childId of node.children) {
		result.push(...collectDescendants(tracker, childId));
	}
	return result;
}

/** Get or create a TaskTracker for a project. */
export async function getTracker(
	ctx: DaemonContext,
	projectId: string,
): Promise<TaskTracker> {
	let tracker = ctx.trackers.get(projectId);
	if (!tracker) {
		const treePath = join(
			ctx.config.dataDir,
			"projects",
			projectId,
			"tree.json",
		);
		tracker = new TaskTracker(treePath);
		await tracker.load();
		ctx.trackers.set(projectId, tracker);
	}
	return tracker;
}

/** Get or create a SessionStore for a project. */
export function getSessionStore(
	ctx: DaemonContext,
	projectId: string,
): SessionStore {
	let store = ctx.sessionStores.get(projectId);
	if (!store) {
		store = new SessionStore(join(ctx.config.dataDir, "sessions", projectId));
		ctx.sessionStores.set(projectId, store);
	}
	return store;
}

/** Resolve the effective config for a project: global + repo + local. */
export async function resolveProjectConfig(
	ctx: DaemonContext,
	projectPath: string,
	projectId: string,
): Promise<OpenGraftConfig> {
	const repoConfig = await loadProjectRepoConfig(projectPath);
	const localConfig = await loadProjectLocalConfig(
		ctx.config.dataDir,
		projectId,
	);
	return resolveConfig(ctx.globalConfig, repoConfig, localConfig);
}

/** Create a provider for a project using resolved config. */
export function getProjectProvider(
	ctx: DaemonContext,
	effectiveConfig: OpenGraftConfig,
): AgentProvider {
	// If a provider was explicitly injected (e.g. tests), use it
	if (ctx.config.agentProvider) return ctx.config.agentProvider;
	return createProviderFromConfig(effectiveConfig);
}

/**
 * Read project memory files (CLAUDE.md and .opengraft/memory.md).
 * @param includeHeaders - When true, adds '[read_file: ...]' headers and a preamble
 *   (used for orchestrator initial prompt). When false, plain concatenation (used for child prompts).
 */
export function readProjectMemory(
	projectPath: string,
	includeHeaders = true,
): string {
	const parts: string[] = [];

	if (includeHeaders) {
		parts.push(
			"The following files have been pre-read for you. Do NOT re-read them unless you need to check for updates.",
		);
	}

	// Read CLAUDE.md for project architecture context
	try {
		const claudeMd = readFileSync(join(projectPath, "CLAUDE.md"), "utf-8");
		if (claudeMd)
			parts.push(
				includeHeaders ? `[read_file: CLAUDE.md]\n${claudeMd}` : claudeMd,
			);
	} catch {
		// No CLAUDE.md, that's fine
	}

	// Read .opengraft/memory.md for agent-specific memory
	try {
		const memory = readFileSync(
			join(projectPath, ".opengraft", "memory.md"),
			"utf-8",
		);
		if (memory)
			parts.push(
				includeHeaders
					? `[read_file: .opengraft/memory.md]\n${memory}`
					: memory,
			);
	} catch {
		// No memory file, that's fine
	}

	return parts.join("\n\n");
}

/**
 * Prune old session files, keeping only the most recent N.
 * Used by autoResumeProjects (startup) and POST /sessions/prune.
 */
export async function pruneSessionFiles(
	ctx: DaemonContext,
	projectId: string,
	keepCount: number,
): Promise<{ pruned: number; remaining: number }> {
	const sessionsDir = join(ctx.config.dataDir, "sessions", projectId);
	try {
		const files = await readdir(sessionsDir).catch(() => []);
		const jsonFiles = files.filter((f) => f.endsWith(".json"));

		if (jsonFiles.length <= keepCount) {
			return { pruned: 0, remaining: jsonFiles.length };
		}

		const withMtime = await Promise.all(
			jsonFiles.map(async (f) => ({
				name: f,
				mtime: (await stat(join(sessionsDir, f))).mtimeMs,
			})),
		);
		withMtime.sort((a, b) => b.mtime - a.mtime);

		const toDelete = withMtime.slice(keepCount);
		await Promise.all(toDelete.map((f) => unlink(join(sessionsDir, f.name))));

		return { pruned: toDelete.length, remaining: keepCount };
	} catch {
		return { pruned: 0, remaining: 0 };
	}
}
