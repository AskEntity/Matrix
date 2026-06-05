/**
 * Matrix scope opts — the matrix plugin's behavioral definition.
 *
 * This is the ONE place that knows about Matrix's tools (orchestrator + builtin),
 * system prompt, git worktrees, work context, and done() semantics. The runtime
 * (`src/runtime/*`) is plugin-agnostic: it only ever invokes these through the
 * `ScopeOpts` hook interface, never by name.
 *
 * Import direction: plugin → src is allowed. Leaf utilities (WorktreeManager,
 * orchestrator tools, system prompt, work context, compaction) live in src/ as
 * neutral building blocks; this file composes them into Matrix's ScopeOpts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSummarizationInstruction } from "../../src/compaction.ts";
import { McpClientManager } from "../../src/mcp-client.ts";
import { createOrchestratorTools } from "../../src/orchestrator-tools.ts";
import type { RuntimeContext, ScopeOpts } from "../../src/runtime/context.ts";
import { resolveProjectConfig } from "../../src/runtime/helpers.ts";
import { buildSystemPrompt } from "../../src/system-prompts.ts";
import { slugify } from "../../src/task-utils.ts";
import { toToolDefinition } from "../../src/tool-def.ts";
import { buildBuiltinToolDefs } from "../../src/tools/index.ts";
import type { TaskNode, TaskStatus } from "../../src/types.ts";
import { buildWorkContextContent } from "../../src/work-context.ts";
import { WorktreeManager } from "../../src/worktree-manager.ts";

/** Matrix's done() result — status + summary. */
export type MatrixDoneData = {
	status: "verify" | "failed";
	summary: string;
};

/** Matrix's plugin type bundle. */
export type MatrixPluginTypes = {
	node: TaskNode;
	done: MatrixDoneData;
};

/**
 * Build the Matrix-default scope options (tools + prompt + worktree hooks).
 * The runtime calls every entry through the ScopeOpts hook contract — it never
 * imports this function by name (the plugin's `buildScopeOpts` wires it in).
 */
export function buildMatrixScopeOpts(
	projectId: string,
	selfBootstrap: boolean,
	ctx?: RuntimeContext,
): ScopeOpts<MatrixPluginTypes> {
	return {
		buildTools: (auth, taskId) => {
			const { toolDefs, hasRunningChildren, setMessages, setAllTools } =
				createOrchestratorTools(auth, projectId, taskId, selfBootstrap);
			const builtinTools = buildBuiltinToolDefs().map((def) =>
				toToolDefinition(def, auth),
			);
			return {
				tools: [...builtinTools, ...toolDefs],
				hasRunningChildren,
				setMessages,
				setAllTools,
			};
		},
		buildPrompt: () =>
			selfBootstrap
				? buildSystemPrompt({ selfBootstrap: true })
				: buildSystemPrompt(),
		connectMcp: ctx
			? async (projectPath) => {
					const mgr = new McpClientManager();
					const cfg = await resolveProjectConfig(ctx, projectPath, projectId);
					if (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0) {
						await mgr.connectAll(cfg.mcpServers, projectPath);
					}
					return mgr;
				}
			: undefined,
		beforeChildLaunch: async (node, tracker, projectPath) => {
			// Already has a valid worktree — ensure cwd is set, return
			if (node.worktreePath && existsSync(node.worktreePath)) {
				if (!node.cwd) node.cwd = node.worktreePath;
				return { cwd: node.cwd };
			}
			// Stale worktreePath — directory was deleted outside close_task
			if (node.worktreePath && !existsSync(node.worktreePath)) {
				node.worktreePath = null;
				node.branch = null;
			}
			const parentNode = tracker.getTaskAbove(node.id);
			const baseBranch = parentNode?.branch;
			if (!baseBranch) {
				throw new Error(
					`Cannot create worktree — current task has no branch assigned.`,
				);
			}
			const wtRoot = join(projectPath, ".worktrees");
			const wm = new WorktreeManager(projectPath, wtRoot);
			const wt = await wm.create(node.id, slugify(node.title), baseBranch);
			tracker.assignWorktree(node.id, wt.branch, wt.path);
			node.cwd = wt.path;
			return { cwd: wt.path };
		},
		onTaskDelete: async (node, projectPath) => {
			// Remove by the STORED worktreePath + branch (rename-proof) — NOT a
			// re-slugified title, which would orphan the real worktree if the
			// task was renamed after the worktree was created.
			if (!node.worktreePath || !node.branch) return;
			const wtRoot = join(projectPath, ".worktrees");
			const wm = new WorktreeManager(projectPath, wtRoot);
			await wm.removeByPath(node.worktreePath, node.branch);
		},
		buildWorkContext: (node, projectPath) =>
			buildWorkContextContent(node.cwd ?? node.worktreePath ?? projectPath),
		buildSummarizationPrompt: (node, projectPath) =>
			buildSummarizationInstruction(
				node.cwd ?? node.worktreePath ?? projectPath,
			),
		buildDoneResumeContext: (node, projectPath) => {
			const cwdLine =
				(node.cwd ?? node.worktreePath ?? projectPath)
					? `\n\n## Working Directory\n${node.cwd ?? node.worktreePath ?? projectPath}`
					: "";
			return `You previously called done(). New messages woke you up:${cwdLine}`;
		},
		shouldResume: (node) => node.status === "in_progress",
		onLaunch: (node, tracker) => {
			tracker.updateStatus(node.id, "in_progress");
		},
		onDone: (node, tracker, doneArgs) => {
			const newStatus = doneArgs.status === "passed" ? "verify" : "failed";
			const summary = (doneArgs.summary as string) ?? "";
			tracker.updateStatus(node.id, newStatus as TaskStatus);
			return { status: newStatus, summary };
		},
	};
}
