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
import { EventStore } from "../event-store.ts";
import type { Event } from "../events.ts";
import { OpenAICompatibleProvider } from "../openai-compatible-provider.ts";
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

/** Get or create an EventStore for a project. */
export function getEventStore(
	ctx: DaemonContext,
	projectId: string,
): EventStore {
	let store = ctx.eventStores.get(projectId);
	if (!store) {
		store = new EventStore(join(ctx.config.dataDir, "sessions", projectId));
		ctx.eventStores.set(projectId, store);
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

/** Read .opengraft/memory.md for the project. Returns content or empty string. */
export function readProjectMemory(projectPath: string): string {
	try {
		const memory = readFileSync(
			join(projectPath, ".opengraft", "memory.md"),
			"utf-8",
		);
		return memory || "";
	} catch {
		return "";
	}
}

/**
 * Prune old event JSONL files, keeping only the most recent N.
 * Used by autoResumeProjects (startup) and POST /sessions/prune.
 */
export async function pruneSessionFiles(
	ctx: DaemonContext,
	projectId: string,
	keepCount: number,
): Promise<{ pruned: number; remaining: number }> {
	const sessionsDir = join(ctx.config.dataDir, "sessions", projectId);
	try {
		const files = await readdir(sessionsDir).catch((e) => {
			console.warn(`[helpers] Failed to read sessions dir ${sessionsDir}:`, e);
			return [] as string[];
		});
		const jsonlFiles = files.filter((f) => f.endsWith(".events.jsonl"));

		if (jsonlFiles.length <= keepCount) {
			return { pruned: 0, remaining: jsonlFiles.length };
		}

		const withMtime = await Promise.all(
			jsonlFiles.map(async (f) => ({
				name: f,
				mtime: (await stat(join(sessionsDir, f))).mtimeMs,
			})),
		);
		withMtime.sort((a, b) => b.mtime - a.mtime);

		const toDelete = withMtime.slice(keepCount);
		await Promise.all(toDelete.map((f) => unlink(join(sessionsDir, f.name))));

		return { pruned: toDelete.length, remaining: keepCount };
	} catch (e) {
		console.warn(
			`[helpers] Failed to prune session files for ${projectId}:`,
			e,
		);
		return { pruned: 0, remaining: 0 };
	}
}

/**
 * Strip fields from an event that the UI doesn't need.
 * Currently strips body.header from message events (contains memory.md content, 10-20KB).
 */
export function stripEventForUI(
	event: Record<string, unknown>,
): Record<string, unknown> {
	if (
		event.type === "message" &&
		event.body &&
		typeof event.body === "object" &&
		"header" in (event.body as Record<string, unknown>)
	) {
		const { header: _, ...bodyRest } = event.body as Record<string, unknown>;
		return { ...event, body: bodyRest };
	}
	return event;
}

/**
 * Normalize an Event from JSONL for UI consumption.
 * Strips UI-irrelevant fields (e.g. body.header).
 * Events already have taskId — this is now just stripEventForUI.
 * (Kept as a named function for callers that pass sessionId for old JSONL backward compat.)
 */
export function normalizeEventForUI(
	event: Event,
	_sessionId: string,
): Record<string, unknown> {
	return stripEventForUI(event as unknown as Record<string, unknown>);
}
