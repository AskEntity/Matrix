/**
 * MCP tool definitions and handlers for orchestration tools.
 *
 * All tools are ToolDef objects:
 * - Handlers receive (args, auth, toolCallId)
 * - Resource IDs come through args (via ParamDecl bind/explicit)
 * - Auth checked via checkPermission (opaque, only auth module can inspect)
 * - Dependencies accessed through global functions in resource-registry.ts
 *
 * createOrchestratorTools() converts ToolDefs to ToolDefinitions
 * for backward compatibility with the existing provider loop.
 */

// readFileSync removed — work_context hook handles memory injection
import { join } from "node:path";
import { z } from "zod";
import { projectIndexDbPath } from "./data-paths.ts";
import { donePayloadSchema } from "./done-payload.ts";
import type { EventSpec } from "./events.ts";
import {
	createCrossProjectMessage,
	createTaskMessage,
	createTreeChange,
} from "./queue-message-factory.ts";
import * as R from "./resource-registry.ts";
import {
	createExecutionProbe,
	type DedupedHit,
	dedupeHitsByTask,
	type ExecutionProbe,
	HIT_IDENTITY_LEGEND,
	statusTag,
	taskAges,
} from "./search-hit-format.ts";
import { type SearchHit, searchIndex } from "./task-index.ts";
import {
	closeTaskOp,
	createTaskOp,
	deleteTaskOp,
	reorderTasksOp,
	resetTaskOp,
	updateTaskOp,
} from "./task-operations.ts";
import type { TaskTracker } from "./task-tracker.ts";
import { getDescendantIds } from "./task-utils.ts";
import type { Auth } from "./tool-auth.ts";
import { checkPermission } from "./tool-auth.ts";
import { defineTool, type ParamDefs, toToolDefinition } from "./tool-def.ts";
import type { ToolDefinition } from "./tool-definition.ts";
import { createDoneTool, createYieldTool } from "./tools/prefab.ts";
import {
	type GeneralNode,
	isTask,
	stripSession,
	type TaskNode,
	type TaskStatus,
	type TreeNode,
} from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

// ── Helpers ──

/**
 * Matrix-plugin-local helper. "Folder" is a matrix-specific concept —
 * one flavor of `GeneralNode` used for visual grouping. Another plugin
 * with its own `GeneralNode.type` strings would define its own predicates.
 */
function isFolder(node: TreeNode): node is GeneralNode & { type: "folder" } {
	return !isTask(node) && node.type === "folder";
}

async function isGitClean(projectPath: string): Promise<{
	clean: boolean;
	files: string;
}> {
	const proc = Bun.spawn(["git", "status", "--porcelain"], {
		cwd: projectPath,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	const output = (await new Response(proc.stdout).text()).trim();
	return { clean: output === "", files: output };
}

/** Error result that the tool-dispatch layer surfaces as isError:true. */
type ToolErrorResult = {
	content: { type: "text"; text: string }[];
	isError: true;
};

/**
 * Enforce `subtree` permission on a destructive operation.
 *
 * `subtree` lets an agent modify itself and its descendants. Applied to
 * every destructive tool so one agent's bug/hallucination cannot delete
 * a sibling or parent's worktree/JSONL (Audit G H1).
 *
 * For folders, permission resolves to the nearest task ancestor — folders
 * have no ownership of their own, they inherit from the enclosing task.
 *
 * `hint` is appended to the refusal when the caller is only PARTLY gated, so
 * the reader is not left to infer that everything about the node is off
 * limits. Only `update_task` needs it today.
 *
 * Returns a tool error result on denial, or `null` to proceed.
 */
function requireSubtreePermission(
	auth: Auth,
	projectId: string,
	nodeId: string,
	opName: string,
	hint?: string,
): ToolErrorResult | null {
	const tracker = R.getTracker(projectId);
	if (!tracker) return null; // downstream handler will report "Project not found"

	const node = tracker.get(nodeId);
	// General node → walk to its owning task; if none (root-level general
	// node), keep the general node's own id and let checkPermission fail it
	// (only root has authority over root-level non-task nodes).
	let targetTaskId = nodeId;
	if (node && !isTask(node)) {
		const owner = tracker.getTaskAbove(nodeId);
		if (owner) targetTaskId = owner.id;
	}
	if (!checkPermission(auth, "subtree", { taskId: targetTaskId })) {
		return {
			content: [
				{
					type: "text",
					text:
						`${opName}: ${nodeId} is not your task or descendant` +
						(hint ? `. ${hint}` : ""),
				},
			],
			isError: true,
		};
	}
	return null;
}

/**
 * The `update_task` fields an agent may set on ANY node, its own or not.
 *
 * Everything NOT listed here is gated on subtree permission — see the
 * argument at the gate itself. `projectId`/`taskId` are routing rather than
 * content, so they never gate anything on their own.
 */
const UNGATED_UPDATE_FIELDS = new Set([
	"projectId",
	"taskId",
	"title",
	"description",
	"old_description",
	"new_description",
	"color",
]);

/**
 * `update_task`'s parameters, hoisted so the handler can NAME them.
 *
 * The refusal for a call that changes nothing has to list the parameters that
 * do work, and that list must be the schema itself rather than a copy of it —
 * a hand-written second list is how a tool ends up advertising a parameter it
 * no longer takes, which is the one error this refusal exists to prevent.
 */
const UPDATE_TASK_PARAMS = {
	projectId: {
		schema: z.string(),
		decl: { kind: "bind", from: "projectId" },
	},
	taskId: {
		schema: z.string().describe("Task node ID"),
		decl: { kind: "explicit" },
	},
	status: {
		schema: z
			.enum(["draft", "pending", "in_progress", "verify", "failed", "closed"])
			.optional(),
		decl: { kind: "optional" },
		description: "New status",
	},
	title: {
		schema: z.string().optional(),
		decl: { kind: "optional" },
		description: "New title",
	},
	description: {
		schema: z.string().optional(),
		decl: { kind: "optional" },
		description:
			"Replaces the ENTIRE description field (full rewrite). " +
			"Use this for major rewrites. For local edits, prefer " +
			"old_description/new_description to avoid accidentally dropping content.",
	},
	old_description: {
		schema: z.string().optional(),
		decl: { kind: "optional" },
		description:
			"Exact substring to find in the current description. Must be unique. " +
			"ONLY this substring is replaced — the rest of the description stays " +
			"byte-identical. Same semantics as edit_file's old_string. " +
			"If you intend to replace the whole description, use the `description` parameter instead.",
	},
	new_description: {
		schema: z.string().optional(),
		decl: { kind: "optional" },
		description:
			"Replacement string for the old_description match. Same semantics as " +
			"edit_file's new_string — only what matched old_description is replaced, " +
			"nothing else in the description changes.",
	},
	draft: {
		schema: z.boolean().optional(),
		decl: { kind: "optional" },
		description:
			"Set draft flag. true = status becomes 'draft', false = status becomes 'pending'.",
	},
	parentId: {
		schema: z.string().optional(),
		decl: { kind: "optional" },
		description:
			"New parent task ID. Moves the task under this parent (reparent).",
	},
	color: {
		schema: z.string().optional(),
		decl: { kind: "optional" },
		description:
			"Color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex). " +
			"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
	},
} satisfies ParamDefs;

/**
 * The parameters an agent can actually supply to change something: every
 * `optional` param. `bind`/`explicit` (projectId, taskId) are routing — they
 * say WHICH task, never WHAT to change.
 */
const UPDATE_TASK_SETTABLE = Object.entries(UPDATE_TASK_PARAMS)
	.filter(([, p]) => p.decl.kind === "optional")
	.map(([name]) => name);

/** Get project path for a task (worktree path or repo root). */
function getProjectPath(projectId: string, taskId: string | null): string {
	const tracker = R.getTracker(projectId);
	if (taskId && tracker) {
		const wp = tracker.getTask(taskId)?.worktreePath;
		if (wp) return wp;
	}
	return R.getProject(projectId)?.path ?? "";
}

/**
 * Post-process events for get_logs output:
 * - Strip thinking `signature` (base64 blobs external clients don't need)
 * - Filter out `usage` events (token counts not useful for observers)
 * - Optionally replace tool_result content with a short summary
 */
function stripEventsForLogs(
	events: unknown[],
	hideToolResults: boolean,
): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	for (const raw of events) {
		const e = raw as Record<string, unknown>;
		// Drop usage events entirely
		if (e.type === "usage") continue;

		let processed: Record<string, unknown> = e;

		// Strip signature from thinking events
		if (processed.type === "thinking") {
			const { signature: _, ...rest } = processed;
			processed = rest;
		}

		// Replace tool_result content with summary
		if (hideToolResults && processed.type === "tool_result") {
			const content = processed.content;
			const len = typeof content === "string" ? content.length : 0;
			processed = {
				...processed,
				content: `(content hidden, ${len} chars)`,
			};
		}

		result.push(processed);
	}
	return result;
}

// ── Search + format (shared by search_tasks + create_task) ──

/** Hard limits for search result formatting (protect context window). */
const DESCRIPTION_CHAR_LIMIT = 500;
const RESULT_CHAR_LIMIT = 300;
const TOTAL_CHAR_LIMIT = 8000;

/** Default tier sizes. */
const DEFAULT_FULL_COUNT = 5;
const DEFAULT_BRIEF_COUNT = 10;

/**
 * Header for the related-tasks block create_task appends to its own result.
 *
 * The guidance lives HERE, in the payload, and not in create_task's tool
 * description, because the description is read when the call is CONSTRUCTED
 * and this decision is made when the result ARRIVES. Nobody asked for these
 * hits, so nothing at call time primes an agent to act on them. (Contrast
 * search_tasks, where the agent asked — there the description reaches it in
 * time, so the same fact is one clause of that description instead.)
 *
 * Emitted only when there is at least one live hit — formatTieredHits returns
 * "" for a header with no entries.
 */
const RELATED_EXISTING_TASKS_HEADER = `\n\n[Related existing tasks] — pointers, not answers: these are truncated excerpts, and "Latest result" is only the FINAL round, often a trivial follow-up. None of it tells you what a task concluded. get_task the ones that look related and read their result rounds. Then: fold what they concluded into this task's description (most often this one — cite the taskId); or fork_task_context from one; or send_message to one instead and delete this just-created task; or nothing, if they are unrelated. A past measurement usually still holds; a past "so we decided not to" may not — this new task can be why it changed. ${HIT_IDENTITY_LEGEND}`;

/**
 * Format a FULL search result entry: identity line (status + execution +
 * taskId), ages, description excerpt, latest result round excerpt, every
 * matched field + the best snippet, score.
 */
function formatFullHit(
	hit: DedupedHit,
	task: TaskNode,
	hasExecuted: ExecutionProbe,
	now: number,
): string {
	const desc = task.description
		? `\n   Description: "${task.description.slice(0, DESCRIPTION_CHAR_LIMIT)}"`
		: "";
	const lastRound = task.resultRounds?.length
		? task.resultRounds[task.resultRounds.length - 1]
		: undefined;
	const result = lastRound?.result
		? `\n   Latest result: "${lastRound.result.slice(0, RESULT_CHAR_LIMIT)}"`
		: "";
	const matchedField = `\n   Matched: ${hit.fields.join(", ")} — "${hit.snippet.slice(0, 200)}"`;
	return (
		`- ${statusTag(task, hasExecuted)} "${task.title}" (${hit.taskId})` +
		`\n   ${taskAges(task, now)}` +
		`${desc}${result}${matchedField}\n   Score: ${hit.score.toFixed(2)}`
	);
}

/**
 * Format a BRIEF search result entry: the same identity — status, execution,
 * taskId, both dates — then the score.
 *
 * ⚠️ The identity is NOT dropped here to save room. A brief entry is exactly
 * the one a reader scans rather than studies, so it is where an unlabelled
 * four-month-old proposal is most likely to be taken for live work. The
 * matched-field list and the excerpts are what brevity costs; what the task IS
 * survives into every tier.
 */
function formatBriefHit(
	hit: DedupedHit,
	task: TaskNode,
	hasExecuted: ExecutionProbe,
	now: number,
): string {
	return (
		`- ${statusTag(task, hasExecuted)} "${task.title}" (${hit.taskId}) ` +
		`${taskAges(task, now)} — score: ${hit.score.toFixed(2)}`
	);
}

/**
 * Build a tiered text block from search hits. Stops appending once the total
 * character budget (TOTAL_CHAR_LIMIT) is exhausted.
 *
 * @param hits        Ranked search hits (best first).
 * @param tracker     Live tracker for fresh node data.
 * @param fullCount   How many of the top TASKS get the FULL treatment.
 * @param hasExecuted Probe answering "did this task ever run" — required, so
 *                    the ran / never-ran marker can never silently degrade
 *                    into a claim the caller had no evidence for.
 * @param header      Optional header line (e.g. "[Related existing tasks]").
 * @returns Formatted text, or "" if no hits resolve to live tasks.
 */
export function formatTieredHits(
	hits: SearchHit[],
	tracker: TaskTracker,
	fullCount: number,
	hasExecuted: ExecutionProbe,
	header?: string,
): string {
	const lines: string[] = [];
	let totalChars = 0;
	const now = Date.now();

	if (header) {
		lines.push(header);
		totalChars += header.length + 1;
	}

	// One entry per TASK before the tier split — so fullCount counts distinct
	// tasks rather than index positions a single task can occupy twice.
	const deduped = dedupeHitsByTask(hits);

	// Tier by position among the tasks actually RENDERED, not among the raw
	// hits: a hit whose task left the tree is skipped, and letting it consume
	// a full slot would silently demote the next real hit to a brief line.
	let rendered = 0;
	for (const hit of deduped) {
		const task = tracker.getTask(hit.taskId);
		if (!task) continue;

		const line =
			rendered < fullCount
				? formatFullHit(hit, task, hasExecuted, now)
				: formatBriefHit(hit, task, hasExecuted, now);

		if (totalChars + line.length + 1 > TOTAL_CHAR_LIMIT) break;
		lines.push(line);
		totalChars += line.length + 1;
		rendered++;
	}

	return lines.length > (header ? 1 : 0) ? lines.join("\n") : "";
}

/**
 * Search the project index and return a tiered formatted string.
 *
 * Uses async hybrid search (BM25 + embedding vectors) for cross-lingual
 * semantic matching. Falls back to BM25-only if the embedding pipeline
 * is unavailable. Returns "" if the index isn't ready or query is empty.
 *
 * @param dbPath      Path to the Orama index file.
 * @param query       Search query string.
 * @param tracker     Live tracker for fresh node data + dead-hit filtering.
 * @param hasExecuted Probe answering "did this task ever run" (see
 *                    `createExecutionProbe`). Positional and required rather
 *                    than an `opts` field: a missing probe would have to
 *                    default to something, and every default here is a claim
 *                    about history the caller did not make.
 * @param opts.fullCount   Top N tasks with full info (default 5).
 * @param opts.briefCount  Next N tasks with brief info (default 10).
 * @param opts.excludeId   Task id to exclude from results (e.g. self).
 * @param opts.header      Optional header line prepended to the output.
 */
export async function searchTasks(
	dbPath: string,
	query: string,
	tracker: TaskTracker,
	hasExecuted: ExecutionProbe,
	opts?: {
		fullCount?: number;
		briefCount?: number;
		excludeId?: string;
		header?: string;
	},
): Promise<string> {
	const fullCount = opts?.fullCount ?? DEFAULT_FULL_COUNT;
	const briefCount = opts?.briefCount ?? DEFAULT_BRIEF_COUNT;
	const trimmed = query.trim();
	if (!trimmed) return "";

	const hits = (
		await searchIndex(dbPath, trimmed, fullCount + briefCount)
	).filter((h) => {
		if (opts?.excludeId && h.taskId === opts.excludeId) return false;
		return !!tracker.getTask(h.taskId);
	});

	return formatTieredHits(hits, tracker, fullCount, hasExecuted, opts?.header);
}

// ── All tool definitions ──

export function buildAllToolDefs() {
	return [
		// ── get_tree ──
		defineTool({
			name: "get_tree",
			availability: "both",
			description:
				"Get the current task tree. Returns each node's id, title, status and place in the hierarchy. It is a shallow view by design — to read one node's description and details, call get_task.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				format: {
					schema: z.enum(["flat", "tree"]).optional(),
					decl: { kind: "optional" },
				},
				include_closed: {
					schema: z.boolean().optional(),
					decl: { kind: "optional" },
					description:
						"Include closed tasks in the result. Default false — closed tasks are hidden to reduce noise.",
				},
			},
			handler: async (args, auth) => {
				const tracker = R.getTracker(args.projectId as string);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};
				// "(you)" marker: agents get their node marked, humans skip.
				const isMe = checkPermission(auth, "human", {})
					? (_nodeId: string) => false
					: (nodeId: string) =>
							checkPermission(auth, "exact", { taskId: nodeId });
				let nodes = tracker.allNodes();
				if (!args.include_closed) {
					nodes = nodes.filter((n) => !isTask(n) || n.status !== "closed");
				}
				const visibleIds = new Set(nodes.map((n) => n.id));
				const filterChildren = (children: string[]) =>
					children.filter((id) => visibleIds.has(id));
				// The projection is minimal and there is no switch to widen it.
				// Returning whole nodes measured ~114K tokens on a 578-node tree,
				// ~631K together with include_closed — one call able to exhaust a
				// context window. Read one node with get_task instead.
				const result = nodes.map((n) => {
					const node: Record<string, unknown> = {
						id: n.id,
						title: n.title + (isMe(n.id) ? " (you)" : ""),
						children: filterChildren(n.children),
						parentId: n.parentId,
					};
					if (isTask(n)) {
						node.status = n.status;
					} else {
						// General nodes (folder, future plugin types) expose their
						// discriminator so observers can distinguish kinds.
						node.type = n.type;
					}
					return node;
				});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ nodes: result }, null, 2),
						},
					],
				};
			},
		}),

		// ── get_task ──
		defineTool({
			name: "get_task",
			availability: "both",
			description:
				"Get a single task's full details including description. Use when you need to read a specific task's description or other detailed fields.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z
						.string()
						.describe("Task node ID (or unique prefix, min 8 chars)"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				const tracker = R.getTracker(args.projectId as string);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};
				const node = tracker.getTask(args.taskId as string);
				if (!node)
					return {
						content: [{ type: "text", text: `Task not found: ${args.taskId}` }],
						isError: true,
					};
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(stripSession(node), null, 2),
						},
					],
				};
			},
		}),

		// ── search_tasks ──
		defineTool({
			name: "search_tasks",
			availability: "both",
			description:
				"Hybrid-search the task tree — every task's title, description, and " +
				"each done() round's result — via BM25 keyword match + semantic " +
				"vector search (cross-lingual: Chinese queries find English results " +
				"and vice versa). Returns the best-matching LOCATIONS: for each hit, " +
				"the task, WHICH field matched (title / description / result), the " +
				"round index (for result), a text snippet, and a relevance score " +
				"(higher = more relevant; results are pre-sorted best-first). Use it " +
				"to find whether a problem was solved before, or where a decision or " +
				"lesson lives, instead of scanning the whole tree. A hit tells you " +
				"WHERE, not WHAT — get_task it and read the result rounds, which is " +
				"where the conclusion actually is. " +
				// This output has no header to carry the legend, and the decision to
				// read a hit as live-or-historical is made when the results arrive.
				// The description is what reaches an agent that ASKED, so it is where
				// the vocabulary has to live for this surface.
				HIT_IDENTITY_LEGEND,
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				query: {
					schema: z
						.string()
						.describe(
							"Search query — keywords and/or natural language (supports Chinese and English).",
						),
					decl: { kind: "explicit" },
				},
				limit: {
					schema: z.number().int().positive().max(100).optional(),
					decl: { kind: "optional" },
					description: "Max hits to return (default 20, max 100).",
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const tracker = R.getTracker(projectId);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};
				const { dataDir, dataRoot } = R.getDataPaths();
				const dbPath = projectIndexDbPath(dataDir, projectId, dataRoot);
				const limit = (args.limit as number | undefined) ?? 20;
				const formatted = await searchTasks(
					dbPath,
					args.query as string,
					tracker,
					createExecutionProbe(dataDir, projectId, dataRoot),
					{
						fullCount: Math.min(5, limit),
						briefCount: Math.max(0, limit - 5),
					},
				);
				return {
					content: [
						{
							type: "text",
							text: formatted || `No results for "${args.query}".`,
						},
					],
				};
			},
		}),

		// ── create_task ──
		defineTool({
			name: "create_task",
			availability: "internal",
			description:
				"Create a new task. " +
				"IMPORTANT: Sibling tasks will run in PARALLEL on separate branches. " +
				"Each sibling must work on DIFFERENT files/modules to avoid merge conflicts. " +
				"NOTE: You can create tasks anywhere in the tree, not just under your own subtree. " +
				"Creating a task is recording an intention — it's always allowed.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				parentId: {
					schema: z.string(),
					decl: { kind: "explicit" },
					description: "Parent task ID.",
				},
				title: {
					schema: z.string().describe("Short title for the task"),
					decl: { kind: "explicit" },
				},
				description: {
					schema: z
						.string()
						.describe(
							"Detailed description of what the task should accomplish",
						),
					decl: { kind: "explicit" },
				},
				draft: {
					schema: z.boolean().optional(),
					decl: { kind: "optional" },
					description:
						"If true, creates the task as a draft. Draft tasks can be edited but not executed.",
				},
				color: {
					schema: z.string().optional(),
					decl: { kind: "optional" },
					description:
						"Optional color label for visual categorization (e.g. 'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'gray' or hex like '#ff5733'). " +
						"Categories: Bug=red, Feature=blue, Refactor=green, Optimization=yellow, Research=purple, Chore=gray.",
				},
			},
			handler: async (args) => {
				try {
					const projectId = args.projectId as string;
					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const defaultBudgetUsd = R.getDefaultBudgetUsd();
					const node = await createTaskOp(
						tracker,
						{
							title: args.title as string,
							description: args.description as string,
							parentId: args.parentId as string,
							draft: args.draft,
							color: args.color,
							budgetUsd: defaultBudgetUsd || undefined,
						},
						"agent",
						{
							broadcastTree: () => R.broadcastTree(projectId),
							projectPath: getProjectPath(projectId, args.parentId),
							dataPaths: { ...R.getDataPaths(), projectId },
						},
					);
					const nodeJson = JSON.stringify(stripSession(node), null, 2);

					// Best-effort: search for related existing tasks.
					let relatedBlock = "";
					try {
						const { dataDir, dataRoot } = R.getDataPaths();
						const dbPath = projectIndexDbPath(dataDir, projectId, dataRoot);
						const query = [args.title, args.description]
							.filter(Boolean)
							.join(" ");
						relatedBlock = await searchTasks(
							dbPath,
							query,
							tracker,
							createExecutionProbe(dataDir, projectId, dataRoot),
							{
								fullCount: 2,
								briefCount: 3,
								excludeId: node.id,
								header: RELATED_EXISTING_TASKS_HEADER,
							},
						);
					} catch {
						// Index not ready or search failed — silently skip.
					}

					return {
						content: [
							{
								type: "text",
								text: nodeJson + relatedBlock,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		// ── update_task ──
		defineTool({
			name: "update_task",
			availability: "internal",
			description:
				"Update a task node. All fields except taskId are optional — " +
				"provide only the fields you want to change. At least one of them is " +
				"required: a call that changes nothing is an error, not a no-op.\n\n" +
				"**All of it or none of it.** If any field is refused, the whole call " +
				"is refused and NO field is applied — including ones the error does " +
				"not mention. Fix what was refused and re-send the entire update.\n\n" +
				"**Scope**: `title`, `description` and `color` can be set on ANY task, " +
				"anywhere in the tree — correcting a task you filed elsewhere is the same " +
				"act as filing it. `status`, `draft` and `parentId` need the target to be " +
				"you or your descendant.\n\n" +
				"**Editing the description field**: treat it like a file. " +
				"Use `description` for a full rewrite (replaces the ENTIRE field). " +
				"Use `old_description` + `new_description` for surgical edits — " +
				"SAME semantics as `edit_file`'s `old_string`/`new_string`: " +
				"the exact substring `old_description` is replaced by `new_description`, " +
				"and everything else stays byte-identical. " +
				"If `old_description` is not unique, provide more surrounding context to disambiguate. " +
				"Cannot combine `description` with `old_description`/`new_description`.",
			params: UPDATE_TASK_PARAMS,
			handler: async (args, auth) => {
				try {
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};

					// A call that can change nothing is refused, not answered with
					// the unchanged task and no error.
					//
					// Unknown keys never reach here — executeTool's Zod parse STRIPS
					// them — so `old_string`/`new_string` (edit_file's names, one
					// door down, and the slip that actually happened) arrive as an
					// update with no fields at all. The old behaviour returned the
					// task and reported success, so the caller moved on and the edit
					// was gone.
					//
					// updateTaskOp refuses this too, and that is the real guarantee
					// — it covers REST as well. This one exists for its WORDING: the
					// op can only name its own fields, which would send an agent
					// after `branch`/`metadata` (not reachable from here) and never
					// mention `old_description` (reachable, and what the slip was
					// reaching for). Never offer a remedy that will not work.
					const supplied = UPDATE_TASK_SETTABLE.filter(
						(p) => (args as Record<string, unknown>)[p] !== undefined,
					);
					if (supplied.length === 0) {
						return {
							content: [
								{
									type: "text",
									text:
										"Error: update_task changed nothing — no updatable parameter was supplied. " +
										`It takes: ${UPDATE_TASK_SETTABLE.join(", ")}. ` +
										"(Unrecognized parameter names are dropped before this tool sees " +
										"them, so a wrong name arrives here as an empty update — note that " +
										"the surgical-edit params are old_description/new_description, NOT " +
										"edit_file's old_string/new_string.)",
								},
							],
							isError: true,
						};
					}

					// What is defended here is STRUCTURE and LIFECYCLE, not the node.
					//
					// `parentId` restructures a tree the agent does not own.
					// `status`/`draft` move a node through a lifecycle someone else
					// is running — flipping a sibling to `verify` puts work in their
					// merge queue that they did not finish, and `draft: false` makes
					// a foreign draft startable. Those keep the check.
					//
					// `title`/`description`/`color` do not. `create_task` already
					// lets an agent author that exact prose at that exact tree
					// position; gating the FIX while allowing the WRITE does not
					// prevent a bad edit, it converts a good one into someone else's
					// chore. Twice observed: an agent that filed a draft outside its
					// subtree and then could not append the provenance that turned
					// it from "a new rule" into "restore a shipped invariant", and
					// one that typo'd a `color` argument into the description TEXT
					// of a task it had created two minutes earlier and could not
					// take it back out. Editing a description is recording intent —
					// the same act as create_task, later in time.
					//
					// The blanket gate this replaces named exactly one instance,
					// `status="closed"` triggering worktree+JSONL cleanup, and that
					// instance is unreachable from here: updateTaskOp refuses
					// "closed" and "failed" outright, and close_task has its own
					// subtree check.
					//
					// ⚠️ Written as a SUBTRACT-list on purpose. The rule is "these
					// named fields record intent; everything else exercises
					// authority", so a param added to this tool later is gated by
					// default and someone hits the refusal and widens the set
					// deliberately. Listing the GATED fields instead states today's
					// complement, and the next field silently lands on the free
					// side with nothing going red.
					const gated = Object.entries(args)
						.filter(
							([k, v]) => v !== undefined && !UNGATED_UPDATE_FIELDS.has(k),
						)
						.map(([k]) => k);
					if (gated.length > 0) {
						const permError = requireSubtreePermission(
							auth,
							args.projectId as string,
							args.taskId as string,
							`Cannot update_task ${gated.join("/")}`,
							"Its title, description and color are editable from anywhere — " +
								"only status, draft and parentId need authority over the node.",
						);
						if (permError) return permError;
					}

					// Reparent also requires permission on the NEW parent.
					if (args.parentId !== undefined) {
						const newParentPermError = requireSubtreePermission(
							auth,
							args.projectId as string,
							args.parentId as string,
							"Cannot reparent — target parent",
						);
						if (newParentPermError) return newParentPermError;
					}

					// Surgical description edit
					let finalDescription = args.description;
					if (
						args.old_description !== undefined ||
						args.new_description !== undefined
					) {
						if (
							args.old_description === undefined ||
							args.new_description === undefined
						) {
							return {
								content: [
									{
										type: "text",
										text: "Error: old_description and new_description must both be provided",
									},
								],
								isError: true,
							};
						}
						if (args.description !== undefined) {
							return {
								content: [
									{
										type: "text",
										text: "Error: cannot use description with old_description/new_description — use one or the other",
									},
								],
								isError: true,
							};
						}
						const existingNode = tracker.getTask(args.taskId as string);
						if (!existingNode?.description) {
							return {
								content: [
									{
										type: "text",
										text: "Error: task has no description to edit",
									},
								],
								isError: true,
							};
						}
						const idx = existingNode.description.indexOf(
							args.old_description as string,
						);
						if (idx === -1) {
							return {
								content: [
									{
										type: "text",
										text: "Error: old_description not found in task description",
									},
								],
								isError: true,
							};
						}
						if (
							existingNode.description.indexOf(
								args.old_description as string,
								idx + 1,
							) !== -1
						) {
							return {
								content: [
									{
										type: "text",
										text: "Error: old_description is not unique in task description — provide more context to make it unique",
									},
								],
								isError: true,
							};
						}
						finalDescription = existingNode.description.replace(
							args.old_description as string,
							args.new_description as string,
						);
					}

					const node = await updateTaskOp(
						tracker,
						args.taskId as string,
						{
							status: args.status as TaskStatus | undefined,
							title: args.title,
							description: finalDescription,
							draft: args.draft,
							parentId: args.parentId,
							color: args.color,
						},
						"agent",
						{
							broadcastTree: () => R.broadcastTree(args.projectId as string),
							notifyTargetNode: (action, nodeId, title) => {
								const targetNode = tracker.getTask(nodeId);
								if (targetNode?.session?.queue) {
									try {
										targetNode.session.queue.enqueue(
											createTreeChange(action, nodeId, title),
											{ quiet: true },
										);
									} catch {
										/* queue may be closed */
									}
								}
							},
							projectPath: getProjectPath(args.projectId as string, null),
							dataPaths: {
								...R.getDataPaths(),
								projectId: args.projectId as string,
							},
						},
					);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(stripSession(node), null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		// ── yield (prefab) ──
		createYieldTool(),

		// ── send_message ──
		defineTool({
			name: "send_message",
			availability: "internal",
			description:
				"Send a message to another task. You can message any ancestor in your parent chain (not just direct parent), " +
				"or any of your direct sub tasks. Valid target states: closed / verify / failed / in_progress / pending (not draft). " +
				"For closed and pending targets, a worktree is auto-created off your current branch and the agent launches on message receipt — " +
				"closed targets additionally resume with their full prior session memory.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				senderTaskId: {
					schema: z.string(),
					decl: { kind: "bind", from: "taskId" },
				},
				taskId: {
					schema: z
						.string()
						.describe(
							"Target task — any ancestor in your parent chain, or any direct sub task",
						),
					decl: { kind: "explicit" },
				},
				title: {
					schema: z.string().describe("Short summary of the message"),
					decl: { kind: "explicit" },
				},
				message: {
					schema: z.string().describe("Message content"),
					decl: { kind: "explicit" },
				},
				requestReply: {
					schema: z.boolean().optional(),
					decl: { kind: "optional" },
					description: "If true, signals that a reply is expected.",
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const senderTaskId = args.senderTaskId;
				const targetTaskId = args.taskId as string;
				const tracker = R.getTracker(projectId);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};

				const node = tracker.getTask(targetTaskId);
				if (!node)
					return {
						content: [
							{
								type: "text",
								text: `Error: Task "${targetTaskId}" not found.`,
							},
						],
						isError: true,
					};

				const currentNode = senderTaskId
					? tracker.getTask(senderTaskId)
					: undefined;

				// Direction check: upward or downward
				let isUpward = false;
				if (senderTaskId) {
					let ancestor = tracker.getTaskAbove(senderTaskId);
					while (ancestor) {
						if (ancestor.id === targetTaskId) {
							isUpward = true;
							break;
						}
						ancestor = tracker.getTaskAbove(ancestor.id);
					}
				}
				let isDownward = false;
				if (!isUpward) {
					if (senderTaskId !== null) {
						const targetTaskAbove = tracker.getTaskAbove(targetTaskId);
						isDownward = targetTaskAbove?.id === senderTaskId;
					} else {
						const targetTaskAbove = tracker.getTaskAbove(targetTaskId);
						isDownward =
							targetTaskAbove?.id === tracker.rootNodeId || !targetTaskAbove;
					}
				}

				if (!isUpward && !isDownward)
					return {
						content: [
							{
								type: "text",
								text: `Error: Can only message ancestors in your parent chain, or your direct sub tasks. "${targetTaskId}" is neither.`,
							},
						],
						isError: true,
					};

				// ── Upward ──
				if (isUpward) {
					try {
						const queueMessage = createTaskMessage(
							senderTaskId ?? "unknown",
							currentNode?.title ?? "unknown",
							args.message as string,
							{
								title: args.title as string,
								requestReply: args.requestReply,
							},
						);
						await R.deliverMessage(projectId, targetTaskId, queueMessage, {
							quiet: true,
						});
						return {
							content: [
								{
									type: "text",
									text: `Message sent to ancestor task "${node.title}".`,
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [
								{
									type: "text",
									text: `Error sending message: ${message}`,
								},
							],
							isError: true,
						};
					}
				}

				// ── Downward ──
				if (node.status === "draft")
					return {
						content: [
							{
								type: "text",
								text: `Error: Task "${node.title}" (${targetTaskId}) is a draft and cannot be started. Remove draft status first.`,
							},
						],
						isError: true,
					};

				try {
					// Pre-flight gates for a fresh child (no worktree yet). The worktree
					// itself is created by beforeChildLaunch (via deliverMessage →
					// ensureChildAgentRunning) under the launch lock. This handler used to
					// ALSO create the worktree inline here — a SECOND `git worktree add`
					// path that raced the launch path for the same node (two quick UI POSTs,
					// REST-vs-send_message, or two send_message calls in one turn) →
					// duplicate `git worktree add` → bogus task_complete(failed) to the
					// parent (B-H2). Worktree creation now has ONE owner (beforeChildLaunch,
					// existsSync-guarded). We keep only the user-facing pre-flight gates that
					// beforeChildLaunch doesn't perform (clean working tree) or reports less
					// clearly (current task has a branch to fork from).
					if (!node.worktreePath) {
						const projPath = getProjectPath(projectId, senderTaskId);
						const gitCheck = await isGitClean(projPath);
						if (!gitCheck.clean) {
							const lines = gitCheck.files.split("\n").filter((l) => l.trim());
							return {
								content: [
									{
										type: "text",
										text: `Error: Working tree has ${lines.length} uncommitted change(s):\n${gitCheck.files}\n\nCommit or stash changes before spawning tasks.`,
									},
								],
								isError: true,
							};
						}
						if (!currentNode?.branch)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot create worktree — current task has no branch assigned.",
									},
								],
								isError: true,
							};
					}

					// No header needed — work_context injected by enqueue hook on fresh sessions
					const hasPriorContext =
						node.session != null || R.hasEventStore(projectId, node.id);
					const queueMessage = createTaskMessage(
						senderTaskId ?? "unknown",
						currentNode?.title ?? "unknown",
						args.message as string,
						{
							requestReply: args.requestReply,
						},
					);

					// deliverMessage auto-launches the child: ensureChildAgentRunning →
					// beforeChildLaunch creates the worktree (under the launch lock) before
					// the agent runs. The branch name isn't known synchronously here (it's
					// derived during async creation), so the success string no longer reports
					// it for a fresh task.
					await R.deliverMessage(projectId, targetTaskId, queueMessage);

					return {
						content: [
							{
								type: "text",
								text: hasPriorContext
									? `Message sent to task "${node.title}" (${targetTaskId})`
									: `Started task "${node.title}" (${targetTaskId})`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text",
								text: `Error starting task: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		}),

		// ── close_task ──
		defineTool({
			name: "close_task",
			availability: "internal",
			description:
				"Take a task out of the active pool — status set to 'closed'; task record + session are preserved. " +
				"Its worktree and branch, if it has them, are removed to reclaim disk, so merge that branch yourself FIRST or the unmerged work is lost. " +
				"A draft or pending task has neither, so closing it is a pure status flip: use that when a draft's work ended up being done elsewhere, instead of deleting the decision record or writing the outcome into its title. " +
				"Only an in_progress task is refused. " +
				"`send_message` later reactivates the closed task — session resumes with full prior memory, worktree rebuilt fresh off your current branch.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("ID of the task to close"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					const projectId = args.projectId as string;
					const permError = requireSubtreePermission(
						auth,
						projectId,
						args.taskId as string,
						"Cannot close_task",
					);
					if (permError) return permError;

					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const repoPath = R.getProject(projectId)?.path ?? "";
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await closeTaskOp(tracker, args.taskId as string, {
						broadcastTree: () => R.broadcastTree(projectId),
						removeWorktree: (_id, worktreePath, branch) =>
							wm.removeByPath(worktreePath, branch),
						clearEventStore: (sid) => R.clearEventStore(projectId, sid),
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ closed: true, ...result }, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		// ── delete_task ──
		defineTool({
			name: "delete_task",
			availability: "internal",
			description:
				"Fully remove a task — deletes worktree, session file, and task node from the tree. " +
				"WARNING: Also deletes ALL sub tasks recursively. Verify all sub tasks are completed and merged before deleting. " +
				"Use for abandoned tasks you no longer need.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("ID of the task to delete"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					const projectId = args.projectId as string;
					const permError = requireSubtreePermission(
						auth,
						projectId,
						args.taskId as string,
						"Cannot delete_task",
					);
					if (permError) return permError;

					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const repoPath = R.getProject(projectId)?.path ?? "";
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await deleteTaskOp(
						tracker,
						args.taskId as string,
						"agent",
						{
							broadcastTree: () => R.broadcastTree(projectId),
							removeWorktree: (_id, worktreePath, branch) =>
								wm.removeByPath(worktreePath, branch),
							clearEventStore: (sid) => R.clearEventStore(projectId, sid),
							// Stop a running agent + await loop exit before cleanup —
							// deleting a running task must not race its live loop.
							stopTask: async (nodeId) => {
								await R.stopTask(projectId, nodeId);
							},
							awaitLoopExit: (nodeId) => R.awaitLoopExit(nodeId),
							dataPaths: { ...R.getDataPaths(), projectId },
						},
					);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ deleted: true, ...result }, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		// ── reset_task ──
		defineTool({
			name: "reset_task",
			availability: "internal",
			description:
				"Reset a task for a fresh start — removes worktree and session file but keeps the node. " +
				"Sets status to pending. Use when you want to retry with a different approach.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("ID of the task to reset"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					const projectId = args.projectId as string;
					const permError = requireSubtreePermission(
						auth,
						projectId,
						args.taskId as string,
						"Cannot reset_task",
					);
					if (permError) return permError;

					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const repoPath = R.getProject(projectId)?.path ?? "";
					const wtRoot = join(repoPath, ".worktrees");
					const wm = new WorktreeManager(repoPath, wtRoot);
					const result = await resetTaskOp(tracker, args.taskId as string, {
						broadcastTree: () => R.broadcastTree(projectId),
						removeWorktree: (_id, worktreePath, branch) =>
							wm.removeByPath(worktreePath, branch),
						clearEventStore: (sid) => R.clearEventStore(projectId, sid),
						stopTask: async (nodeId) => {
							await R.stopTask(projectId, nodeId);
						},
						awaitLoopExit: (nodeId) => R.awaitLoopExit(nodeId),
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ reset: true, ...result }, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		// ── clarify ──
		defineTool({
			name: "clarify",
			availability: "internal",
			description:
				"Ask a clarification question and send it to the user. " +
				"Returns immediately — you can continue doing other work that doesn't need the answer, " +
				"then call yield() when ready to wait for the clarify_response. " +
				"Only use this for genuine ambiguities that could lead to wasted work.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string(),
					decl: { kind: "bind", from: "taskId" },
				},
				question: {
					schema: z
						.string()
						.describe("The clarification question to ask the user"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				const taskId = (args.taskId as string) ?? "orchestrator";
				R.emit(args.projectId as string, taskId, {
					type: "clarification_requested",
					question: args.question as string,
					...((args.question as string).includes("\n")
						? {
								title: (args.question as string).split("\n")[0],
								body: (args.question as string)
									.split("\n")
									.slice(1)
									.join("\n")
									.trim(),
							}
						: { title: args.question }),
					ts: Date.now(),
				} as EventSpec);
				R.broadcastTree(args.projectId as string);
				return {
					content: [
						{
							type: "text",
							text: "Question sent. You can continue working on other things that don't need the answer, then call yield() when ready to receive the clarify_response.",
						},
					],
				};
			},
		}),

		// ── reorder_tasks ──
		defineTool({
			name: "reorder_tasks",
			availability: "internal",
			description:
				"Reorder children of a task node. The children array must contain exactly the same task IDs as the current children, just in a different order.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				nodeId: {
					schema: z
						.string()
						.describe("Parent task ID whose children to reorder"),
					decl: { kind: "explicit" },
				},
				children: {
					schema: z
						.array(z.string())
						.describe("Ordered list of child task IDs"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					// Scope validation via auth
					if (
						!checkPermission(auth, "subtree", {
							taskId: args.nodeId as string,
						})
					) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot reorder children of ${args.nodeId}: not your task or descendant`,
								},
							],
							isError: true,
						};
					}
					const tracker = R.getTracker(args.projectId as string);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					await reorderTasksOp(
						tracker,
						args.nodeId as string,
						args.children as string[],
						"agent",
						{
							broadcastTree: () => R.broadcastTree(args.projectId as string),
						},
					);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										reordered: true,
										nodeId: args.nodeId,
										children: args.children,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		// ── Folder tools ──
		// Permission: folders defer to their enclosing task (same rule as the
		// rest of the destructive tool suite). Root-level folders resolve to
		// the root task, so only a root agent can mutate them.
		defineTool({
			name: "create_folder",
			availability: "internal",
			description:
				"Create a folder for visual grouping. Folders have no status, no lifecycle — pure organization. " +
				"Tasks inside folders are logically owned by the nearest task ancestor above the folder.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				parentId: {
					schema: z.string(),
					decl: { kind: "explicit" },
					description: "Parent node ID.",
				},
				title: {
					schema: z.string().describe("Folder title"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					const projectId = args.projectId as string;
					// Permission check against the parent — you can only create a
					// folder somewhere you already have authority to mutate.
					const permError = requireSubtreePermission(
						auth,
						projectId,
						args.parentId as string,
						"Cannot create_folder",
					);
					if (permError) return permError;

					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const folder = tracker.addGeneralNode(
						args.title as string,
						args.parentId as string,
						"folder",
					);
					await tracker.save();
					R.broadcastTree(projectId);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(folder, null, 2),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		defineTool({
			name: "delete_folder",
			availability: "internal",
			description:
				"Delete an empty folder. Fails if the folder has children — move or delete them first.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				folderId: {
					schema: z.string().describe("ID of the folder to delete"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					const projectId = args.projectId as string;
					const permError = requireSubtreePermission(
						auth,
						projectId,
						args.folderId as string,
						"Cannot delete_folder",
					);
					if (permError) return permError;

					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const node = tracker.get(args.folderId as string);
					if (!node)
						return {
							content: [{ type: "text", text: "Folder not found" }],
							isError: true,
						};
					if (!isFolder(node))
						return {
							content: [
								{
									type: "text",
									text: "Not a folder — use delete_task instead",
								},
							],
							isError: true,
						};
					if (node.children.length > 0)
						return {
							content: [
								{
									type: "text",
									text: "Cannot delete folder with children. Move or delete them first.",
								},
							],
							isError: true,
						};
					tracker.remove(args.folderId as string);
					await tracker.save();
					R.broadcastTree(projectId);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									deleted: true,
									folderId: args.folderId,
									title: node.title,
								}),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		defineTool({
			name: "rename_folder",
			availability: "internal",
			description: "Rename a folder.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				folderId: {
					schema: z.string().describe("ID of the folder to rename"),
					decl: { kind: "explicit" },
				},
				title: {
					schema: z.string().describe("New title for the folder"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				try {
					const projectId = args.projectId as string;
					const permError = requireSubtreePermission(
						auth,
						projectId,
						args.folderId as string,
						"Cannot rename_folder",
					);
					if (permError) return permError;

					const tracker = R.getTracker(projectId);
					if (!tracker)
						return {
							content: [{ type: "text", text: "Project not found" }],
							isError: true,
						};
					const node = tracker.get(args.folderId as string);
					if (!node)
						return {
							content: [{ type: "text", text: "Folder not found" }],
							isError: true,
						};
					if (!isFolder(node))
						return {
							content: [
								{
									type: "text",
									text: "Not a folder — use update_task instead",
								},
							],
							isError: true,
						};
					tracker.updateTitle(args.folderId as string, args.title as string);
					await tracker.save();
					R.broadcastTree(projectId);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									renamed: true,
									folderId: args.folderId,
									title: args.title,
								}),
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [{ type: "text", text: `Error: ${message}` }],
						isError: true,
					};
				}
			},
		}),

		// ── list_projects ──
		defineTool({
			name: "list_projects",
			availability: "both",
			description:
				"List all registered projects with their IDs, names, and paths. " +
				"Use this to discover other projects before sending cross-project messages.",
			params: {},
			handler: async (_args, auth) => {
				if (!checkPermission(auth, "root", {})) {
					return {
						content: [
							{
								type: "text",
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}
				const projects = R.listProjects();
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(projects, null, 2),
						},
					],
				};
			},
		}),

		// ── get_logs ──
		defineTool({
			name: "get_logs",
			availability: "external",
			description:
				"Returns session events for a task, with cursor-based pagination. " +
				"Events are returned after the last compact/fork marker. " +
				"Use begin/end cursors to read a range (e.g., from yield_external's cursor).",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				taskId: {
					schema: z.string().describe("Task node ID to fetch logs for"),
					decl: { kind: "explicit" },
				},
				begin: {
					schema: z.number().optional(),
					decl: { kind: "optional" },
					description:
						"Start cursor (inclusive). Events from this position onward.",
				},
				end: {
					schema: z.number().optional(),
					decl: { kind: "optional" },
					description: "End cursor (exclusive). Events up to this position.",
				},
				hideToolResults: {
					schema: z.boolean().optional(),
					decl: { kind: "optional" },
					description:
						"Hide tool_result content (default true). When true, content is replaced with a short summary.",
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const hideToolResults = args.hideToolResults ?? true;
				const tracker = R.getTracker(projectId);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};
				const node = tracker.getTask(taskId);
				if (!node)
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						isError: true,
					};
				const eventStore = R.getEventStore(projectId);
				await eventStore.flushSession(taskId);
				const { events: allEvents, hasOlderEvents } =
					eventStore.readFromLastCompactMarker(taskId);
				const begin = args.begin;
				const end = args.end;
				// Apply cursor range — precise slice, no limit needed
				const sliced = allEvents.slice(begin ?? 0, end);
				const processed = stripEventsForLogs(sliced, hideToolResults);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									taskId,
									events: processed,
									cursor: allEvents.length,
									hasOlderEvents,
								},
								null,
								2,
							),
						},
					],
				};
			},
		}),

		// ── send_message_to_project ──
		defineTool({
			name: "send_message_to_project",
			availability: "internal",
			description:
				"Send a message to the orchestrator of another project. " +
				"The message appears in the target project's orchestrator queue as a cross_project message. " +
				"If the target project has no active agent, one is auto-launched with the message as the initial prompt.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
					description: "Sender's project ID (auto-bound).",
				},
				targetProjectId: {
					schema: z.string().describe("ID of the target project"),
					decl: { kind: "explicit" },
				},
				message: {
					schema: z.string().describe("Message content to send"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				if (!checkPermission(auth, "root", {})) {
					return {
						content: [
							{
								type: "text",
								text: "Cross-project tools are not available at this depth.",
							},
						],
						isError: true,
					};
				}
				const senderProjectId = args.projectId as string;
				const targetProjectId = args.targetProjectId as string;

				const targetProject = R.getProject(targetProjectId);
				if (!targetProject)
					return {
						content: [
							{
								type: "text",
								text: `Error: Project "${targetProjectId}" not found.`,
							},
						],
						isError: true,
					};

				const senderProject = R.getProject(senderProjectId);
				const fromProjectName = senderProject?.name ?? "unknown";

				// Try direct enqueue if target agent is running
				const targetTracker = R.getTracker(targetProjectId);
				const targetRootId = targetTracker?.rootNodeId;
				const targetQueue = targetRootId
					? targetTracker?.getTask(targetRootId)?.session?.queue
					: undefined;
				if (targetQueue) {
					try {
						targetQueue.enqueue(
							createCrossProjectMessage(
								senderProjectId,
								fromProjectName,
								args.message as string,
							),
						);
						return {
							content: [
								{
									type: "text",
									text: `Message sent to project "${targetProject.name}" (${targetProjectId}).`,
								},
							],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : "Unknown error";
						return {
							content: [
								{
									type: "text",
									text: `Error sending message: ${message}`,
								},
							],
							isError: true,
						};
					}
				}

				// Auto-launch via inject
				try {
					const prefixedMessage = `[Cross-project message from "${fromProjectName}" (${senderProjectId})]\n\n${args.message}`;
					const result = await R.injectMessageToProject(
						targetProjectId,
						prefixedMessage,
					);
					if (!result.ok) {
						return {
							content: [
								{
									type: "text",
									text: `Error: ${result.error ?? "Failed to launch agent for target project."}`,
								},
							],
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Message sent to project "${targetProject.name}" (${targetProjectId}). Agent was not running and has been auto-launched.`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text",
								text: `Error sending message: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		}),

		// ── fork_task_context ──
		defineTool({
			name: "fork_task_context",
			availability: "internal",
			description:
				"Copy a task's conversation context into a target task's session. " +
				"When sourceTaskId == your own taskId, the system picks your next assignment afterward — follow the tool result. " +
				"When sourceTaskId is another task, you remain unchanged — you're orchestrating a context transfer. " +
				"The target task starts with the source's full conversation history so the new agent doesn't cold-start. After forking, use send_message to start the target agent. " +
				"IMPORTANT: fork_task_context must be the ONLY tool call in the turn — it cannot be called alongside other tools.",
			params: {
				projectId: {
					schema: z.string(),
					decl: { kind: "bind", from: "projectId" },
				},
				sourceTaskId: {
					schema: z
						.string()
						.describe(
							"ID of the task whose session context to copy. Must have an existing JSONL session.",
						),
					decl: { kind: "explicit" },
				},
				targetTaskId: {
					schema: z
						.string()
						.describe(
							"ID of the task to receive the forked context. Must NOT have an existing session.",
						),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args, auth) => {
				const projectId = args.projectId as string;
				const sourceId = args.sourceTaskId as string;
				const targetId = args.targetTaskId as string;

				if (!R.hasEventStore(projectId, sourceId))
					return {
						content: [
							{
								type: "text",
								text: `Error: Source task "${sourceId}" has no session data to fork from.`,
							},
						],
						isError: true,
					};

				const tracker = R.getTracker(projectId);
				if (!tracker)
					return {
						content: [{ type: "text", text: "Project not found" }],
						isError: true,
					};

				const targetNode = tracker.getTask(targetId);
				if (!targetNode)
					return {
						content: [
							{
								type: "text",
								text: `Error: Target task "${targetId}" not found.`,
							},
						],
						isError: true,
					};

				if (R.hasEventStore(projectId, targetId))
					return {
						content: [
							{
								type: "text",
								text: `Error: Target task "${targetId}" already has session data. Use reset_task first to clear it.`,
							},
						],
						isError: true,
					};

				// Scope validation via auth
				if (!checkPermission(auth, "subtree", { taskId: targetId })) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Target task "${targetId}" is not your task or descendant.`,
							},
						],
						isError: true,
					};
				}

				try {
					const result = await R.copySessionFrom(
						projectId,
						sourceId,
						targetId,
						{
							targetTitle: targetNode.title,
							targetDescription: targetNode.description,
						},
					);
					return {
						content: [
							{
								type: "text",
								text: `fork_task_context completed. You are the PARENT. Forked ${sourceId} → "${targetNode.title}" (${targetId}). Copied ${result.eventCount} events. Use send_message to start the child agent.`,
							},
						],
					};
				} catch (e) {
					const message = e instanceof Error ? e.message : "Unknown error";
					return {
						content: [
							{
								type: "text",
								text: `Error forking context: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		}),

		// ── done (prefab with Matrix guards) ──
		createDoneTool({
			description:
				"Signal that you have finished working on your task. " +
				"Call this when you are done — either passed (task completed successfully) or failed (you cannot continue). " +
				"This is the proper way to exit. Do NOT just stop responding — always call done().",
			extraParams: {
				status: {
					schema: z
						.enum(["passed", "failed"])
						.describe("Whether the task passed or failed"),
					decl: { kind: "explicit" },
				},
				// `result` is the DonePayload content field — its TYPE comes from the
				// ONE source (donePayloadSchema.shape) so the tool input can't drift
				// from the stored round shape.
				result: {
					schema: donePayloadSchema.shape.result.describe(
						"What this round ACTUALLY accomplished (if passed) or what went wrong (if failed) — one focused narrative paragraph. " +
							"Required and non-empty. This is BOTH sent to your parent as the completion notice AND captured as durable, " +
							"structured memory on the task; write it for a future agent searching past work, not only for your parent right now.",
					),
					decl: { kind: "explicit" },
				},
			},
			beforeDone: async (args) => {
				// `result` is required-non-empty: reject a blank/whitespace-only outcome
				// so the memory index never captures an empty round. (An ABSENT result
				// is already rejected by the Zod schema before we reach here.)
				if (!args.result?.trim()) {
					return (
						"done() needs a non-empty `result`: state what this round ACTUALLY " +
						"accomplished (if passed) or what went wrong (if failed)."
					);
				}
				// Matrix-specific: reject done() if worktree has uncommitted changes
				const projPath = getProjectPath(args.projectId, args.taskId);
				const gitCheck = await isGitClean(projPath);
				if (!gitCheck.clean) {
					return (
						`Cannot call done() — your worktree has uncommitted changes:\n${gitCheck.files}\n\n` +
						`Resolve this yourself — protect your work, do the right thing. ` +
						`If you're waiting for direction on what to do with these changes, call yield() instead of done().`
					);
				}
				return null;
			},
		}),
	];
}

// ── evaluate_script (hidden, selfBootstrap only) ──

function buildEvaluateScriptTool(
	messagesRef: { current: unknown[] },
	allToolsRef: { current: unknown[] },
) {
	return defineTool({
		name: "evaluate_script",
		availability: "internal",
		description:
			"Execute arbitrary JavaScript/TypeScript code for runtime introspection. " +
			"Only available in self-bootstrap mode.",
		params: {
			projectId: {
				schema: z.string(),
				decl: { kind: "bind", from: "projectId" },
			},
			taskId: {
				schema: z.string(),
				decl: { kind: "bind", from: "taskId" },
			},
			script: {
				schema: z.string().describe("JavaScript/TypeScript code to evaluate"),
				decl: { kind: "explicit" },
			},
		},
		hidden: true,
		handler: async (args) => {
			try {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const tracker = R.getTracker(projectId);
				const session = R.getSession(projectId, taskId);
				const evalContext = {
					messages: messagesRef.current,
					tracker,
					queue: session?.queue,
					projectId,
					taskId,
					sessionId: taskId,
					daemonCtx: R.getRuntimeContext(),
					allTools: allToolsRef.current,
				};

				const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
				const fn = new AsyncFunction("ctx", args.script as string);

				const logs: string[] = [];
				const origLog = console.log;
				const origError = console.error;
				const origWarn = console.warn;
				console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
				console.error = (...a: unknown[]) =>
					logs.push(`[error] ${a.map(String).join(" ")}`);
				console.warn = (...a: unknown[]) =>
					logs.push(`[warn] ${a.map(String).join(" ")}`);

				let result: unknown;
				try {
					result = await fn(evalContext);
				} finally {
					console.log = origLog;
					console.error = origError;
					console.warn = origWarn;
				}

				const parts: string[] = [];
				if (logs.length > 0) {
					parts.push(`## Console Output\n${logs.join("\n")}`);
				}
				if (result !== undefined) {
					const resultStr =
						typeof result === "string"
							? result
							: JSON.stringify(result, null, 2);
					parts.push(`## Return Value\n${resultStr}`);
				}
				return {
					content: [
						{
							type: "text",
							text: parts.length > 0 ? parts.join("\n\n") : "(no output)",
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Eval error: ${e instanceof Error ? e.message : String(e)}${e instanceof Error && e.stack ? `\n${e.stack}` : ""}`,
						},
					],
					isError: true,
				};
			}
		},
	});
}

// ── Public API ──

/** Result of createOrchestratorTools — raw tool definitions for provider forwarding. */
export interface OrchestratorToolsResult {
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic is not narrowable here
	toolDefs: ToolDefinition<any>[];
	hasRunningChildren?: () => boolean;
	setMessages?: (msgs: unknown[]) => void;
	setAllTools?: (tools: unknown[]) => void;
}

/**
 * Create orchestrator tools for an agent.
 *
 * @param auth - Opaque auth handle for permission checks
 * @param projectId - Project this agent belongs to
 * @param taskId - Task this agent is running as (null = root)
 * @param selfBootstrap - Enable hidden evaluate_script tool
 */
export function createOrchestratorTools(
	auth: Auth,
	projectId: string,
	taskId: string,
	selfBootstrap?: boolean,
): OrchestratorToolsResult {
	const allDefs = buildAllToolDefs();

	// Convert all ToolDefs to ToolDefinitions via the adapter
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	const toolDefs: ToolDefinition<any>[] = allDefs.map((def) =>
		toToolDefinition(def, auth),
	);

	// evaluate_script (hidden, selfBootstrap only)
	const messagesRef = { current: [] as unknown[] };
	const allToolsRef = { current: [] as unknown[] };
	let setMessages: ((msgs: unknown[]) => void) | undefined;
	let setAllTools: ((tools: unknown[]) => void) | undefined;

	if (selfBootstrap) {
		setMessages = (msgs: unknown[]) => {
			messagesRef.current = msgs;
		};
		setAllTools = (tools: unknown[]) => {
			allToolsRef.current = tools;
		};
		const evalDef = buildEvaluateScriptTool(messagesRef, allToolsRef);
		toolDefs.push(toToolDefinition(evalDef, auth));
	}

	return {
		toolDefs,
		setMessages,
		setAllTools,
		hasRunningChildren: () => {
			const tracker = R.getTracker(projectId);
			if (!tracker) return false;
			return getDescendantIds(tracker, taskId).some(
				(id) => tracker.getTask(id)?.session != null,
			);
		},
	};
}
