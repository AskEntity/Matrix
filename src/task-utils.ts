/**
 * Task utility functions — helpers for task tree traversal, prompt building,
 * message formatting, and slug generation.
 */

import { pinyin } from "pinyin-pro";
import { formatEventForAI, queueMessageToEvent } from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import type { TaskTracker } from "./task-tracker.ts";
import { isTask } from "./types.ts";

/** Named color → hex mapping for agent tools. Accepts common names and converts to hex. */
const NAMED_COLORS: Record<string, string> = {
	red: "#f85149",
	blue: "#388bfd",
	green: "#3fb950",
	yellow: "#d29922",
	purple: "#a371f7",
	orange: "#f0883e",
	gray: "#768390",
};

/** Resolve a color value: converts named colors to hex, passes hex through. */
export function resolveColor(color: string): string {
	return NAMED_COLORS[color.toLowerCase()] ?? color;
}

/**
 * Check if nodeId is a descendant of ancestorId by walking up the parent chain.
 */
export function isDescendantOf(
	tracker: TaskTracker,
	nodeId: string,
	ancestorId: string,
): boolean {
	let current = tracker.get(nodeId);
	while (current) {
		if (current.parentId === ancestorId) return true;
		if (!current.parentId) return false;
		current = tracker.get(current.parentId);
	}
	return false;
}

/**
 * Collect all descendant node IDs of a given ancestor (breadth-first).
 * Includes direct children, grandchildren, etc.
 */
export function getDescendantIds(
	tracker: TaskTracker,
	ancestorId: string,
): string[] {
	const result: string[] = [];
	const queue = [...(tracker.get(ancestorId)?.children ?? [])];
	while (queue.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees shift returns a value
		const id = queue.shift()!;
		result.push(id);
		const node = tracker.get(id);
		if (node?.children?.length) {
			queue.push(...node.children);
		}
	}
	return result;
}

/** Format a QueueMessage for display to the agent. */
export function formatQueueMessage(msg: QueueMessage): string {
	return formatEventForAI(queueMessageToEvent(msg, ""));
}

/** @internal Exported for testing */
export function buildTaskPrompt(
	node: {
		id: string;
		title: string;
		description: string;
		parentId: string | null;
		branch?: string | null;
		worktreePath?: string | null;
		budgetUsd?: number;
	},
	tracker: TaskTracker,
	memory: string,
): string {
	const parts: string[] = [];

	if (memory) {
		parts.push("# .mxd/memory.md (Preloaded, do not read again)", memory, "");
	}

	parts.push(`# Task: ${node.title}`);
	parts.push(`Task ID: \`${node.id}\``);
	// Add "Your task is part of" line for task navigation context
	// Uses getTaskAbove to skip folders — agents message their owning task, not the folder.
	if (node.parentId) {
		const taskAbove = tracker.getTaskAbove(node.id);
		if (taskAbove) {
			parts.push(
				`\nYour task is part of "${taskAbove.title}" (\`${taskAbove.id}\`). Send messages to \`${taskAbove.id}\` to discuss questions or coordinate.`,
			);
		}
	}
	if (node.budgetUsd) {
		parts.push(
			`**Budget: ${"$"}${node.budgetUsd.toFixed(2)}** — you will be warned at 80% and must wrap up at 100%.`,
		);
	}
	if (node.description) {
		parts.push(node.description);
	}

	// Include branch/worktree info so the agent knows where it is
	if (node.branch) {
		parts.push(
			`\n## Git Context`,
			`You are on branch: \`${node.branch}\``,
			`Your working directory is already set to \`${node.worktreePath ?? "unknown"}\` — do NOT cd to it.`,
			`Do NOT switch branches. All commits go on \`${node.branch}\`.`,
		);
	}

	if (node.parentId) {
		const siblings = tracker.getChildren(node.parentId);
		const done = siblings.filter(
			(s) => isTask(s) && (s.status === "verify" || s.status === "closed"),
		);
		if (done.length > 0) {
			parts.push(
				"\n## Already completed siblings:",
				...done.map((s) => `- ${s.title} (${isTask(s) ? s.status : "folder"})`),
			);
		}
	}

	parts.push(
		"\n## Instructions",
		"1. Follow `.mxd/memory.md` for project-specific knowledge.",
		"2. Implement this task: types → tests → implementation → all checks passing.",
		"3. Run `bun test`, `bun run typecheck`, and `bun run check` before considering done.",
		"4. If you discover something important, append it to `.mxd/memory.md` using edit_file (match last lines + extend) or bash `echo >> .mxd/memory.md`. Never use write_file on memory.md — it duplicates content.",
		"5. Commit all changes (including memory updates) when all checks pass.",
	);

	return parts.join("\n");
}

/** @internal Exported for testing */
export function slugify(title: string): string {
	// Convert CJK characters to pinyin, leaving ASCII untouched
	const romanized = title.replace(
		/[\u4e00-\u9fff\u3400-\u4dbf]+/g,
		(match) => ` ${pinyin(match, { toneType: "none" })} `,
	);
	const slug = romanized
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 30);
	return slug || "task";
}

/**
 * Find the nearest ancestor with an active queue for a given node.
 * Walks up the parent chain to bubble through non-running intermediate nodes.
 * Returns both the queue and the ID of the ancestor it belongs to.
 */
export function findParentQueue(
	tracker: TaskTracker,
	nodeId: string,
): { queue: MessageQueue; targetId: string } | undefined {
	const node = tracker.get(nodeId);
	if (!node?.parentId) return undefined;

	// Walk up through all ancestors (including folders) looking for a running task
	let targetId: string | null = node.parentId;
	while (targetId) {
		const ancestor = tracker.get(targetId);
		if (!ancestor) break;

		// Skip folders — they can't have queues
		if (isTask(ancestor)) {
			const queue = ancestor.session?.queue;
			if (queue) return { queue, targetId };
		}

		// Reached root without finding a queue — root isn't running
		if (!ancestor.parentId) break;

		targetId = ancestor.parentId;
	}

	return undefined;
}

/**
 * Clean up all resources for a task and its descendants:
 * close agent queues, remove worktrees/branches, clear JSONL event stores.
 * Both MCP delete_task and REST DELETE call this — single codepath.
 */
export async function cleanupTaskResources(
	tracker: TaskTracker,
	nodeId: string,
	deps: {
		/** Remove the worktree by its STORED path + branch (rename-proof). */
		removeWorktree: (
			taskId: string,
			worktreePath: string,
			branch: string,
		) => Promise<void>;
		clearEventStore: (nodeId: string) => void;
	},
): Promise<void> {
	const descendantIds = getDescendantIds(tracker, nodeId);
	const allIds = [nodeId, ...descendantIds];

	for (const id of allIds) {
		const n = tracker.getTask(id);
		if (!n) continue;

		// Close running agent session + queue
		if (n.session?.queue) {
			n.session.queue.close();
			n.session = undefined;
		}

		// Remove worktree + branch by the STORED path + branch — NOT a
		// re-slugified title (rename-proof; the title may have changed since
		// the worktree was created, which would orphan the real worktree).
		if (n.worktreePath && n.branch) {
			try {
				await deps.removeWorktree(n.id, n.worktreePath, n.branch);
			} catch {
				/* worktree may already be gone */
			}
		}

		// Delete event JSONL files
		deps.clearEventStore(n.id);
	}
}
