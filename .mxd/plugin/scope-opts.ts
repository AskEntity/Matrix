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
import { projectIndexDbPath } from "../../src/data-paths.ts";
import { parseDonePayload } from "../../src/done-payload.ts";
import { McpClientManager } from "../../src/mcp-client.ts";
import { createOrchestratorTools } from "../../src/orchestrator-tools.ts";
import type { RuntimeContext, ScopeOpts } from "../../src/runtime/context.ts";
import { resolveProjectConfig } from "../../src/runtime/helpers.ts";
import { buildSystemPrompt } from "../../src/system-prompts.ts";
import {
	indexTask,
	reconcileIndex,
	type SearchHit,
	searchIndexSync,
} from "../../src/task-index.ts";
import { slugify } from "../../src/task-utils.ts";
import { toToolDefinition } from "../../src/tool-def.ts";
import { buildBuiltinToolDefs } from "../../src/tools/index.ts";
import type { TaskNode } from "../../src/types.ts";
import { buildWorkContextContent } from "../../src/work-context.ts";
import { WorktreeManager } from "../../src/worktree-manager.ts";

/** Maximum characters for the [Related past tasks] block (~2000 tokens). */
const RELATED_TASKS_CHAR_LIMIT = 8000;

/**
 * Format search hits into a concise work_context block.
 * Each hit is one line with title, task id prefix, field, and snippet.
 * Truncated at RELATED_TASKS_CHAR_LIMIT to protect the context window.
 */
function formatRelatedTasks(
	hits: SearchHit[],
	tracker: import("../../src/task-tracker.ts").TaskTracker,
): string {
	if (hits.length === 0) return "";

	const lines: string[] = ["[Related past tasks]"];
	let totalChars = lines[0]!.length;

	for (const hit of hits) {
		const task = tracker.getTask(hit.taskId);
		const title = task?.title ?? "unknown";
		const idPrefix = hit.taskId.slice(0, 12);
		const fieldLabel =
			hit.field === "result" && hit.roundIndex !== undefined
				? `result round ${hit.roundIndex}`
				: hit.field;
		const snippet = hit.snippet.slice(0, 150);
		const line = `- "${title}" (task ${idPrefix}…, ${fieldLabel}): "${snippet}"`;

		if (totalChars + line.length + 1 > RELATED_TASKS_CHAR_LIMIT) break;
		lines.push(line);
		totalChars += line.length + 1;
	}

	return lines.length > 1 ? lines.join("\n") : "";
}

/** Matrix's plugin type bundle. */
export type MatrixPluginTypes = {
	node: TaskNode;
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
		buildWorkContext: (node, projectPath, projId) => {
			const base = buildWorkContextContent(
				node.cwd ?? node.worktreePath ?? projectPath,
			);
			// Inject related past tasks from the search index (sync, cached DB).
			// Uses the task's title + description as the search query.
			if (ctx) {
				try {
					const dbPath = projectIndexDbPath(
						ctx.config.dataDir,
						projId,
						ctx.config.dataRoot,
					);
					const query = [node.title, node.description]
						.filter(Boolean)
						.join(" ");
					if (query.trim()) {
						const hits = searchIndexSync(dbPath, query, 5).filter(
							(h) => h.taskId !== node.id,
						);
						const tracker = ctx.trackers.get(projId);
						if (hits.length > 0 && tracker) {
							const block = formatRelatedTasks(hits, tracker);
							if (block) return base ? `${base}\n\n${block}` : block;
						}
					}
				} catch {
					// Best-effort — index not available or not loaded yet.
				}
			}
			return base;
		},
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
		// Startup: reconcile the search index (backfill on first run, incremental
		// after) — the fallback for anything index-on-done missed (crash between
		// done and index write, or title/description edits via update_task that
		// never fire onDone). Best-effort: swallow + log so a bad index write can
		// never block agent resume. Needs ctx for the dataRoot; without it (some
		// test harnesses) the index simply isn't maintained here.
		onScopeResume: ctx
			? async (tracker, projId) => {
					try {
						await reconcileIndex(
							projectIndexDbPath(
								ctx.config.dataDir,
								projId,
								ctx.config.dataRoot,
							),
							tracker,
						);
					} catch (e) {
						console.warn(
							`[task-index] startup reconcile failed for ${projId}:`,
							e,
						);
					}
				}
			: undefined,
		onDone: (node, tracker, doneInput) => {
			// Content-only: rebuild this round's DonePayload (result) from the opaque
			// done() input and append it — one block per done(), append-only, never
			// overwritten. Status routing (→ verify/failed), the parent notice, and
			// the crash-safe marker are the RUNTIME's job; the runtime never reads
			// the round content — only Matrix does, right here.
			tracker.appendResultRound(node.id, parseDonePayload(doneInput));
			// Index-on-done: keep the search index fresh on the common path. Read
			// the canonical post-append node so the just-added round is included.
			// Best-effort — an index write must NEVER break the done lifecycle;
			// the startup reconcile retries any miss. Fire-and-forget — onDone is
			// sync in the runtime contract, but the async indexTask runs in the
			// background. Errors are caught + logged; the promise is not awaited.
			if (ctx) {
				const fresh = tracker.getTask(node.id) ?? node;
				indexTask(
					projectIndexDbPath(
						ctx.config.dataDir,
						projectId,
						ctx.config.dataRoot,
					),
					fresh,
				).catch((e) => {
					console.warn(`[task-index] index-on-done failed for ${node.id}:`, e);
				});
			}
		},
	};
}
