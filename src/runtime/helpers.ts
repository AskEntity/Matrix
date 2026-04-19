import { readFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProvider } from "../agent-provider.ts";
import { AnthropicCompatibleProvider } from "../anthropic-compatible-provider.ts";
import {
	type AuthGroup,
	loadProjectLocalConfig,
	loadProjectRepoConfig,
	type MatrixConfig,
	resolveAuthGroup,
	resolveConfig,
} from "../config.ts";
import {
	projectDebugDir,
	projectTasksDir,
	projectTreeJsonPath,
} from "../data-paths.ts";
import { EventStore } from "../event-store.ts";
import { OpenAIResponsesCompatibleProvider } from "../openai-responses-compatible-provider.ts";
import { TaskTracker } from "../task-tracker.ts";
import type { TreeNode } from "../types.ts";
import type { RuntimeContext } from "./context.ts";

// Re-export so existing callers importing path builders from ./helpers keep working.
// data-paths.ts is the single source of truth; helpers.ts is a convenience barrel.
export { projectDebugDir, projectTasksDir, projectTreeJsonPath };

/** Create an AgentProvider from an AuthGroup, model, and optional thinking effort. */
function createProviderFromAuth(
	authGroup: AuthGroup,
	model?: string,
	thinkingEffort?: number,
): AgentProvider {
	if (authGroup.provider === "anthropic") {
		return new AnthropicCompatibleProvider(model, {
			apiKey: authGroup.apiKey,
			oauthToken: authGroup.oauthToken,
			systemPreamble: authGroup.systemPreamble,
			thinkingEffort,
		});
	}
	return new OpenAIResponsesCompatibleProvider(model, {
		apiKey: authGroup.apiKey,
		accessToken: authGroup.accessToken,
		refreshToken: authGroup.refreshToken,
		accountId: authGroup.accountId,
		baseUrl: authGroup.baseUrl,
	});
}

/** Create a provider from resolved config. Requires an auth group to be configured. */
function createProviderFromConfig(
	effectiveConfig: MatrixConfig,
): AgentProvider {
	const authGroup = resolveAuthGroup(effectiveConfig);
	if (!authGroup) {
		throw new Error(
			"No auth group configured. Add an auth group in Settings > Global > Auth Groups and set defaultAuth.",
		);
	}
	return createProviderFromAuth(
		authGroup,
		effectiveConfig.model,
		effectiveConfig.thinkingEffort,
	);
}

/** Collect a node and all its descendants. */
export function collectDescendants(
	tracker: TaskTracker,
	nodeId: string,
): TreeNode[] {
	const node = tracker.get(nodeId);
	if (!node) return [];
	const result: TreeNode[] = [node];
	for (const childId of node.children) {
		result.push(...collectDescendants(tracker, childId));
	}
	return result;
}

/** Detect the current branch of a git repo. Returns undefined if not a git repo. */
async function detectBranch(projectPath: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: projectPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode === 0) {
			const branch = (await new Response(proc.stdout).text()).trim();
			if (branch && branch !== "HEAD") return branch;
		}
	} catch {
		// Not a git repo or git not available
	}
	return undefined;
}

/** Get or create a TaskTracker for a project. */
export async function getTracker(
	ctx: RuntimeContext,
	projectId: string,
): Promise<TaskTracker> {
	let tracker = ctx.trackers.get(projectId);
	if (!tracker) {
		const treePath = projectTreeJsonPath(
			ctx.config.dataDir,
			projectId,
			ctx.config.dataRoot,
		);
		tracker = new TaskTracker(treePath);
		const project = ctx.pm.get(projectId);
		const defaultBranch = project
			? await detectBranch(project.path)
			: undefined;
		await tracker.load(defaultBranch);
		// Backfill root worktreePath = project root
		const root = tracker.getTask(tracker.rootNodeId);
		if (root && !root.worktreePath && project) {
			root.worktreePath = project.path;
		}
		ctx.trackers.set(projectId, tracker);
	}

	// Register scope opts if not already set and builder is available.
	// autoResumeProjects sets these explicitly; this catches projects
	// accessed for the first time via REST/MCP (not resumed at startup).
	// Without buildScopeOpts (bare worker, no plugin runtime), CRUD still works
	// — only agent lifecycle paths need scope opts.
	if (!ctx.scopeOpts.has(projectId) && ctx.config.buildScopeOpts) {
		ctx.scopeOpts.set(projectId, ctx.config.buildScopeOpts(projectId, ctx));
	}
	return tracker;
}

/** Get or create an EventStore for a project. */
export function getEventStore(
	ctx: RuntimeContext,
	projectId: string,
): EventStore {
	let store = ctx.eventStores.get(projectId);
	if (!store) {
		store = new EventStore(
			projectTasksDir(ctx.config.dataDir, projectId, ctx.config.dataRoot),
		);
		ctx.eventStores.set(projectId, store);
	}
	return store;
}

/** Resolve the effective config for a project: global + repo + local. */
export async function resolveProjectConfig(
	ctx: RuntimeContext,
	projectPath: string,
	projectId: string,
): Promise<MatrixConfig> {
	const repoConfig = await loadProjectRepoConfig(projectPath);
	const localConfig = await loadProjectLocalConfig(
		ctx.config.dataDir,
		projectId,
	);
	return resolveConfig(ctx.globalConfig, repoConfig, localConfig);
}

/** Create a provider for a project using resolved config. */
export function getProjectProvider(
	ctx: RuntimeContext,
	effectiveConfig: MatrixConfig,
): AgentProvider {
	// If a provider was explicitly injected (e.g. tests), use it
	if (ctx.config.agentProvider) return ctx.config.agentProvider;
	return createProviderFromConfig(effectiveConfig);
}

/** Read .mxd/memory.md for the project. Returns content or empty string. */
export function readProjectMemory(projectPath: string): string {
	try {
		const memory = readFileSync(
			join(projectPath, ".mxd", "memory.md"),
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
	ctx: RuntimeContext,
	projectId: string,
	keepCount: number,
): Promise<{ pruned: number; remaining: number }> {
	const tasksDir = projectTasksDir(
		ctx.config.dataDir,
		projectId,
		ctx.config.dataRoot,
	);
	try {
		const files = await readdir(tasksDir).catch((e) => {
			console.warn(`[helpers] Failed to read tasks dir ${tasksDir}:`, e);
			return [] as string[];
		});
		const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

		if (jsonlFiles.length <= keepCount) {
			return { pruned: 0, remaining: jsonlFiles.length };
		}

		const withMtime = await Promise.all(
			jsonlFiles.map(async (f) => ({
				name: f,
				mtime: (await stat(join(tasksDir, f))).mtimeMs,
			})),
		);
		withMtime.sort((a, b) => b.mtime - a.mtime);

		const toDelete = withMtime.slice(keepCount);
		await Promise.all(toDelete.map((f) => unlink(join(tasksDir, f.name))));

		return { pruned: toDelete.length, remaining: keepCount };
	} catch (e) {
		console.warn(
			`[helpers] Failed to prune session files for ${projectId}:`,
			e,
		);
		return { pruned: 0, remaining: 0 };
	}
}
