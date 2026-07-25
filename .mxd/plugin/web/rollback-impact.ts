/**
 * Rollback impact analysis.
 *
 * Rewind/Edit rewrites the CONVERSATION (the JSONL chain), nothing else.
 * Everything the agent DID in the rolled-back range — files written, tasks
 * created, messages delivered to other agents — stays exactly as it is.
 *
 * This module scans the log entries that would disappear and reports which
 * kinds of side effects happened there, so the confirm dialog can tell the
 * user what will NOT be undone. Pure: no DOM, no React, no fetch.
 */

import { stripMcpPrefix } from "../tool-names.ts";

/** Minimal structural shape this analysis needs from a LogEntry. */
export type ImpactEntry = {
	type: string;
	tool?: string;
	eid?: string;
	taskId?: string;
};

export type RollbackImpact = {
	/** write_file / edit_file / bash ran — file changes survive the rollback. */
	filesModified: boolean;
	/** Task-tree mutations ran — nodes/status/worktrees survive the rollback. */
	tasksModified: boolean;
	/** Messages were delivered to other agents — they can't be recalled. */
	messagesSent: boolean;
	/**
	 * A tool ran that is neither known-read-only nor in a category above
	 * (external MCP tools, evaluate_script, …). We can't claim "no side
	 * effects" for those, so the dialog warns generically.
	 */
	otherSideEffects: boolean;
	/** Deduped tool names (MCP prefix stripped) in first-call order. */
	toolNames: string[];
};

/** Tools that write to the filesystem / run arbitrary commands. */
const FILE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

/**
 * Tools that mutate the task tree (nodes, status, worktrees, sessions).
 *
 * `done` belongs here AND in MESSAGE_TOOLS: it flips the task's status to
 * verify/failed and delivers task_complete to the task above. Rolling the
 * conversation back past a done() undoes neither — the parent may already
 * have woken up, reviewed, and merged.
 */
const TASK_TOOLS = new Set([
	"create_task",
	"update_task",
	"delete_task",
	"close_task",
	"reset_task",
	"reorder_tasks",
	"execute_tasks",
	"create_folder",
	"delete_folder",
	"rename_folder",
	"fork_task_context",
	"done",
]);

/** Tools that deliver something to another agent / the user. */
const MESSAGE_TOOLS = new Set([
	"send_message",
	"send_message_to_project",
	"send_message_to_child",
	"report_to_parent",
	"clarify",
	"done",
]);

/**
 * Tools with no side effects outside the conversation. Anything NOT listed
 * here and not categorized above sets `otherSideEffects` — unknown tools are
 * assumed to do something, never assumed safe.
 *
 * `yield` is a pure loop pause. `background` covers list/status; a kill is a
 * stop, not a state change we could roll back either way. `done` is NOT here
 * — see TASK_TOOLS.
 */
const READ_ONLY_TOOLS = new Set([
	"read_file",
	"list_files",
	"search",
	"search_tasks",
	"get_tree",
	"get_task",
	"get_logs",
	"list_projects",
	"background",
	"yield",
]);

const EMPTY_IMPACT: RollbackImpact = {
	filesModified: false,
	tasksModified: false,
	messagesSent: false,
	otherSideEffects: false,
	toolNames: [],
};

/** True when the impact carries at least one warning-worthy side effect. */
export function hasSideEffects(impact: RollbackImpact): boolean {
	return (
		impact.filesModified ||
		impact.tasksModified ||
		impact.messagesSent ||
		impact.otherSideEffects
	);
}

/**
 * Scan from the entry carrying `targetEid` to the end of the log and classify
 * every tool call in between.
 *
 * Range: the target entry (the user message being rewound) INCLUSIVE — it is
 * itself replaced — through the newest entry. Entries belonging to a different
 * task than the target are skipped: rollback is per-session, so a sibling
 * agent's bash call must not be reported as this session's impact.
 *
 * Unknown target eid → empty impact (no warnings). The caller shows a plain
 * confirmation; it never claims more than it knows.
 */
export function analyzeRollbackImpact(
	entries: readonly ImpactEntry[],
	targetEid: string,
): RollbackImpact {
	const targetIdx = entries.findIndex((e) => e.eid === targetEid);
	if (targetIdx < 0) return { ...EMPTY_IMPACT, toolNames: [] };

	const targetTaskId = entries[targetIdx]?.taskId;
	const impact: RollbackImpact = { ...EMPTY_IMPACT, toolNames: [] };
	const seen = new Set<string>();

	for (let i = targetIdx; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		if (entry.type !== "tool_call" && entry.type !== "tool_pair") continue;
		// Per-session: skip entries from other tasks (undefined taskId on
		// either side means "unknown" — keep it rather than silently drop).
		if (
			targetTaskId !== undefined &&
			entry.taskId !== undefined &&
			entry.taskId !== targetTaskId
		) {
			continue;
		}
		const name = stripMcpPrefix(entry.tool ?? "");
		if (!name) continue;
		if (!seen.has(name)) {
			seen.add(name);
			impact.toolNames.push(name);
		}
		// Independent membership, NOT a first-match chain: a tool can carry
		// more than one kind of side effect (done() changes task status AND
		// notifies the task above). The sets are otherwise disjoint, so every
		// single-category tool behaves exactly as before.
		const isFile = FILE_TOOLS.has(name);
		const isTask = TASK_TOOLS.has(name);
		const isMessage = MESSAGE_TOOLS.has(name);
		if (isFile) impact.filesModified = true;
		if (isTask) impact.tasksModified = true;
		if (isMessage) impact.messagesSent = true;
		if (!isFile && !isTask && !isMessage && !READ_ONLY_TOOLS.has(name)) {
			impact.otherSideEffects = true;
		}
	}

	return impact;
}
