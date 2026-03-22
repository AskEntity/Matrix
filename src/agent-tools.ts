/**
 * Agent tools — re-exports and helper functions.
 *
 * This file was split for maintainability:
 * - System prompts → src/system-prompts.ts
 * - Orchestrator tool definitions + handlers → src/orchestrator-tools.ts
 * - Helpers + re-exports → this file (src/agent-tools.ts)
 *
 * All existing imports from "./agent-tools" continue to work unchanged.
 */

import { pinyin } from "pinyin-pro";
import { formatEventForAI, queueMessageToEvent } from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";
import type { TaskTracker } from "./task-tracker.ts";

export {
	CostAccumulator,
	createOrchestratorTools,
	type LifecycleDeps,
	type OrchestratorToolsResult,
} from "./orchestrator-tools.ts";
// Re-export everything from the split modules so existing imports keep working
export {
	ROOT_ORCHESTRATOR_PREAMBLE,
	UNIFIED_SYSTEM_PROMPT,
} from "./system-prompts.ts";

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
	const evt = queueMessageToEvent(msg);
	const time = new Date(evt.ts).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	return `[${time}] ${formatEventForAI(evt)}`;
}

/** Convert a QueueMessage to a simplified { source, content } for structured WS events. */
export function toRawMessage(msg: QueueMessage): {
	source: string;
	content: string;
	id?: string;
	images?: { base64: string; mediaType: string }[];
} {
	switch (msg.source) {
		case "child_complete":
			return {
				source: msg.source,
				content: `Task "${msg.title}" (${msg.taskId}) ${msg.success ? "passed" : "failed"}: ${msg.output.slice(0, 500)}`,
			};
		case "user":
			return {
				source: msg.source,
				content: msg.content,
				...(msg.id ? { id: msg.id } : {}),
				...(msg.images?.length ? { images: msg.images } : {}),
			};
		case "system":
			return { source: msg.source, content: msg.content };
		case "parent_update":
			return { source: msg.source, content: msg.content };
		case "clarify_response":
			return { source: msg.source, content: msg.answer };
		case "child_report":
			return {
				source: msg.source,
				content: `From child "${msg.title}" (${msg.taskId}): ${msg.content}`,
			};
		case "cross_project":
			return {
				source: msg.source,
				content: `From project "${msg.fromProjectName}" (${msg.fromProjectId}): ${msg.content}`,
			};
		case "background_complete":
			return {
				source: msg.source,
				content: `Command "${msg.command}" (${msg.commandId}): exit=${msg.exitCode}, duration=${msg.durationMs}ms. Use read_file on output files to see results.`,
			};
		case "compact":
			return { source: msg.source, content: "Manual compaction requested" };
	}
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
		parts.push("## Project Memory", memory, "");
	}

	parts.push(`# Task: ${node.title}`);
	parts.push(`Task ID: \`${node.id}\``);
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
		const done = siblings.filter((s) => s.status === "passed");
		if (done.length > 0) {
			parts.push(
				"\n## Already completed siblings:",
				...done.map((s) => `- ${s.title} (passed)`),
			);
		}
	}

	parts.push(
		"\n## Instructions",
		"1. Read `.opengraft/memory.md` first for project-specific knowledge.",
		"2. Implement this task: types → tests → implementation → all checks passing.",
		"3. Run `bun test`, `bun run typecheck`, and `bun run check` before considering done.",
		"4. If you discover something important, append it to `.opengraft/memory.md` using edit_file (match last lines + extend) or bash `echo >> .opengraft/memory.md`. Never use write_file on memory.md — it duplicates content.",
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

	let targetId: string | null = node.parentId;
	while (targetId) {
		const queue = tracker.get(targetId)?.session?.queue;
		if (queue) return { queue, targetId };

		const ancestor = tracker.get(targetId);
		if (!ancestor) break;

		// Reached root without finding a queue — root isn't running
		if (!ancestor.parentId) break;

		targetId = ancestor.parentId;
	}

	return undefined;
}
