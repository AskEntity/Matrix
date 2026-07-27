/**
 * How a search hit reports WHAT IT IS — shared by every surface that renders
 * hits, so the three cannot drift apart.
 *
 * The surfaces: `search_tasks`' output and `create_task`'s
 * `[Related existing tasks]` appendix (both through `formatTieredHits` in
 * `orchestrator-tools.ts`), and `work_context`'s `[Related past tasks]` block
 * (`formatRelatedTasks` in `.mxd/plugin/scope-opts.ts`). A rule enforced at two
 * of three renderers is enforced nowhere — the third goes on handing out the
 * old shape to a reader who cannot tell which renderer produced it.
 *
 * Every hit answers four questions before its body is read: what status is it,
 * how old is it, when was its record last touched, and — for a terminal task —
 * did it ever actually run. Each of those exists because a real misreading
 * happened without it; see the notes on each function.
 *
 * Leaf module: imports only path/fs helpers and types. Both `src/` and the
 * plugin import it, so it must not reach back into either.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectTasksDir } from "./data-paths.ts";
import type { SearchHit } from "./task-index.ts";
import type { TaskNode, TaskStatus } from "./types.ts";

/** Answers "has this task ever executed?" for one node. */
export type ExecutionProbe = (task: TaskNode) => boolean;

/**
 * The statuses a task can no longer leave under its own power. Only these
 * carry the ran / never-ran marker.
 *
 * Why terminal-only rather than every status: for a live status the question
 * is still open, so the marker would be transient noise. For `closed` and
 * `failed` it is settled and it decides how to READ the description — a task
 * that ran leaves a record, a task that never ran leaves a proposal. Both
 * answers are common in practice: measured on this repo's tree (2026-07-27),
 * 417 of 440 closed tasks had run and 23 had not, while `draft` was 2/104 and
 * `pending` 1/8 — near-certain either way, i.e. a marker with no information.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
	"closed",
	"failed",
]);

/**
 * Build the "did this task ever execute" probe for one project.
 *
 * ⚠️ It is the UNION of three signals, not a choice between them, and that is a
 * measured decision rather than caution. Each signal is one-directional
 * POSITIVE evidence — a session file, a recorded cost and a reported round can
 * only exist if the task ran — so OR-ing them cannot produce a false "ran",
 * while any one of them alone produces false "never ran"s:
 *
 * | signal | really answers | measured blind spot (this repo's tree, 2026-07-27) |
 * |---|---|---|
 * | `resultRounds` | did it REPORT? | postdates most of the tree: **365 of the 417 closed tasks that had run carried no round** |
 * | `costUsd > 0` | did it SPEND? | 1 closed task had a session and no cost (launched, died before any usage landed) |
 * | session JSONL | did it ever HAVE a session? | 1 closed task had a cost and no file — a session can be cleared by hand or by `reset_task` |
 *
 * Picking `resultRounds` — the field that most obviously means "it finished" —
 * would have mislabelled 88% of this repo's executed history as never executed.
 *
 * Order is cost-driven: both in-memory signals are checked before the syscall,
 * so `existsSync` only runs for a task that already looks like it never ran.
 */
export function createExecutionProbe(
	dataDir: string,
	projectId: string,
	dataRoot?: string,
): ExecutionProbe {
	const tasksDir = projectTasksDir(dataDir, projectId, dataRoot);
	return (task) =>
		(task.resultRounds?.length ?? 0) > 0 ||
		task.costUsd > 0 ||
		existsSync(join(tasksDir, `${task.id}.jsonl`));
}

/**
 * A probe for callers with no project paths — in-memory signals only.
 *
 * Weaker on purpose and named so at the call site: it cannot see a task that
 * ran but never reported and never recorded a cost. Do not reach for it in
 * production, where the paths are always available.
 */
export const inMemoryExecutionProbe: ExecutionProbe = (task) =>
	(task.resultRounds?.length ?? 0) > 0 || task.costUsd > 0;

/**
 * Compact age of an ISO timestamp: `3h` / `12d` / `4mo` / `2y`.
 *
 * ⚠️ The relative form is the load-bearing half, not decoration. Agents are
 * date-blind and fail confidently at it — context stamps are `[HH:MM:SS]` with
 * no date, and an agent stalled for 8 days once read 14:56 → 16:13 as "about
 * 80 minutes". An absolute date alone re-runs that failure: what drives "does
 * this still count?" is the age, and nothing in an agent's context computes it.
 */
export function relativeAge(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "?";
	const ms = now - then;
	if (ms < 3_600_000) return "just now";
	const hours = Math.floor(ms / 3_600_000);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(ms / 86_400_000);
	if (days < 30) return `${days}d`;
	if (days < 365) return `${Math.round(days / 30.44)}mo`;
	return `${Math.round(days / 365.25)}y`;
}

/** `2026-04-01 (4mo ago)` — the date that cannot lie, plus the age that drives the judgment. */
export function dateWithAge(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "unknown";
	const age = relativeAge(iso, now);
	return `${new Date(then).toISOString().slice(0, 10)}${age === "just now" ? " (just now)" : ` (${age} ago)`}`;
}

/**
 * The leading `[status]` / `[status · ran]` tag.
 *
 * ⚠️ It leads the line deliberately. The status was always rendered — at the
 * END of the first line, where a long title pushes it to the right margin and
 * the next thing the eye lands on is a 300-char `Description:` that reads like
 * a conclusion. A draft holding an unexecuted proposal and a closed task
 * holding a finished record were then separated by four characters nobody
 * reached.
 */
export function statusTag(task: TaskNode, hasExecuted: ExecutionProbe): string {
	const status = task.status ?? "unknown";
	if (!TERMINAL_STATUSES.has(status)) return `[${status}]`;
	return `[${status} · ${hasExecuted(task) ? "ran" : "never ran"}]`;
}

/**
 * `created 2026-04-01 (4mo ago) · record touched 2026-07-12 (2w ago)`
 *
 * ⚠️ `updatedAt` is deliberately NOT called "last active" or "last worked on",
 * and the label is the whole point of rendering it. `task-tracker.ts` writes
 * that field in 16 places and only 3 of them touch a field anyone would call
 * content — a status flip, a cost update, assigning a worktree, or merely
 * creating a CHILD (which bumps the parent) all refresh it. Labelled as work,
 * it would show an April task as active today: an authoritative-looking wrong
 * number, which is worse than no date at all. `createdAt` is always rendered
 * beside it because it is the one that cannot drift.
 */
export function taskAges(task: TaskNode, now: number = Date.now()): string {
	return `created ${dateWithAge(task.createdAt, now)} · record touched ${dateWithAge(task.updatedAt, now)}`;
}

/** `description` / `result round 2` — which field of the task matched. */
export function matchedFieldLabel(hit: {
	field: string;
	roundIndex?: number;
}): string {
	return hit.field === "result" && hit.roundIndex !== undefined
		? `result round ${hit.roundIndex}`
		: hit.field;
}

/** A hit that has absorbed the other hits on the same task. */
export interface DedupedHit extends SearchHit {
	/** Every field this task matched on, best-scoring first. */
	fields: string[];
}

/**
 * Collapse hits to one entry per task, keeping the best-ranked one and merging
 * the other matches' field labels into it.
 *
 * Input must be ranked best-first (`searchIndex` guarantees it), which is what
 * makes first-wins the same as best-wins — the tier split downstream already
 * depends on that ordering.
 *
 * ⚠️ This runs BEFORE the full/brief tier split, not after. Measured on a real
 * `search_tasks(limit 6)`: three tasks filled all six slots, one of them
 * appearing once as a full entry and once as a brief one, with its entire
 * `Description:` paragraph repeated verbatim. Deduping after the split would
 * leave the slot count computed on the duplicates and hand back three entries
 * where six were asked for.
 *
 * Multi-field matches are merged rather than dropped: a task that matched on
 * both its title and its description is more relevant than one that matched
 * once, and that is exactly what the discarded duplicates were evidence of.
 */
export function dedupeHitsByTask(hits: SearchHit[]): DedupedHit[] {
	const out: DedupedHit[] = [];
	const byTask = new Map<string, DedupedHit>();
	for (const hit of hits) {
		const label = matchedFieldLabel(hit);
		const seen = byTask.get(hit.taskId);
		if (seen) {
			if (!seen.fields.includes(label)) seen.fields.push(label);
			continue;
		}
		const entry: DedupedHit = { ...hit, fields: [label] };
		byTask.set(hit.taskId, entry);
		out.push(entry);
	}
	return out;
}

/**
 * The one sentence every hit-rendering surface uses to explain its own
 * vocabulary. Kept here rather than written out at each header so the prose
 * cannot describe one format while another renderer emits a different one.
 */
export const HIT_IDENTITY_LEGEND =
	"Each hit opens with what it IS: `[status · ran|never ran]` — on a closed or failed task `never ran` means no session, no cost and no reported round, so its description is a proposal nobody executed, not a record of work. `record touched` is when the node record last changed, which a status flip or a new child also bumps — it is NOT when work last happened; `created` is the one that cannot drift.";
